using Grayjay.Desktop.POC;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;

namespace Grayjay.ClientServer.RemoteBrowser
{
    public sealed class CdpException : Exception
    {
        public int Code { get; }
        public string Method { get; }
        public CdpException(string method, int code, string message) : base($"CDP {method} failed ({code}): {message}")
        {
            Code = code;
            Method = method;
        }
    }

    internal readonly record struct CdpEvent(string Method, JsonElement Params, string? SessionId);

    /// <summary>
    /// Minimal Chrome DevTools Protocol client over a raw WebSocket (flattened session mode).
    /// Responses are matched by id; events are dispatched sequentially on a dedicated loop so that
    /// event handlers may freely issue (and await) further commands without blocking the receive loop.
    /// </summary>
    internal sealed class CdpConnection : IDisposable
    {
        private static readonly JsonSerializerOptions _jsonOptions = new JsonSerializerOptions()
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };
        private static readonly JsonElement _emptyObject = JsonDocument.Parse("{}").RootElement.Clone();

        private readonly ClientWebSocket _ws = new ClientWebSocket();
        private readonly Channel<(byte[] Bytes, TaskCompletionSource<JsonElement> Tcs)> _outgoing = Channel.CreateUnbounded<(byte[], TaskCompletionSource<JsonElement>)>(new UnboundedChannelOptions() { SingleReader = true });
        private readonly ConcurrentDictionary<int, (string Method, TaskCompletionSource<JsonElement> Tcs)> _pending = new();
        private readonly Channel<CdpEvent> _events = Channel.CreateUnbounded<CdpEvent>(new UnboundedChannelOptions() { SingleReader = true });
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private int _nextId = 0;
        private int _disconnected = 0;

        public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);

        public event Action<CdpEvent>? OnEvent;
        public event Action? OnDisconnected;

        public bool IsConnected => _ws.State == WebSocketState.Open && _disconnected == 0;

        public async Task ConnectAsync(Uri uri, CancellationToken cancellationToken)
        {
            _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            await _ws.ConnectAsync(uri, timeout.Token);
            _ = Task.Run(ReceiveLoopAsync);
            _ = Task.Run(DispatchLoopAsync);
            _ = Task.Run(SendLoopAsync);
        }

        private async Task SendLoopAsync()
        {
            try
            {
                await foreach (var (bytes, tcs) in _outgoing.Reader.ReadAllAsync(_cts.Token))
                {
                    if (tcs.Task.IsCompleted)
                        continue; //timed out / cancelled before it was sent
                    try
                    {
                        await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, _cts.Token);
                    }
                    catch (Exception ex)
                    {
                        tcs.TrySetException(ex);
                        if (_ws.State != WebSocketState.Open)
                            break;
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                Logger.w(nameof(CdpConnection), "DevTools send loop failed: " + ex.Message);
            }
            finally
            {
                MarkDisconnected();
            }
        }

        public Task<JsonElement> SendAsync(string method, object? parameters = null, string? sessionId = null, TimeSpan? timeout = null, CancellationToken cancellationToken = default)
        {
            return SendInternalAsync(method, parameters, sessionId, timeout ?? DefaultTimeout, cancellationToken);
        }

        /// <summary>Sends a command and swallows (logs at verbose level) any failure.</summary>
        public async Task<JsonElement?> TrySendAsync(string method, object? parameters = null, string? sessionId = null, TimeSpan? timeout = null)
        {
            try
            {
                return await SendInternalAsync(method, parameters, sessionId, timeout ?? DefaultTimeout, CancellationToken.None);
            }
            catch (Exception ex)
            {
                Logger.v(nameof(CdpConnection), $"{method} failed (ignored): {ex.Message}");
                return null;
            }
        }

        private async Task<JsonElement> SendInternalAsync(string method, object? parameters, string? sessionId, TimeSpan timeout, CancellationToken cancellationToken)
        {
            if (_disconnected != 0)
                throw new InvalidOperationException("DevTools connection is closed.");

            var id = Interlocked.Increment(ref _nextId);
            var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pending[id] = (method, tcs);
            try
            {
                var message = new Dictionary<string, object?>()
                {
                    ["id"] = id,
                    ["method"] = method,
                    ["params"] = parameters ?? new { }
                };
                if (sessionId != null)
                    message["sessionId"] = sessionId;
                var bytes = JsonSerializer.SerializeToUtf8Bytes(message, _jsonOptions);

                //Queued synchronously, so commands reach the browser in call order even when not awaited one by one.
                if (!_outgoing.Writer.TryWrite((bytes, tcs)))
                    throw new InvalidOperationException("DevTools connection is closed.");

                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _cts.Token);
                timeoutCts.CancelAfter(timeout);
                using var registration = timeoutCts.Token.Register(() =>
                {
                    if (cancellationToken.IsCancellationRequested)
                        tcs.TrySetCanceled(cancellationToken);
                    else if (_cts.IsCancellationRequested)
                        tcs.TrySetException(new InvalidOperationException("DevTools connection is closed."));
                    else
                        tcs.TrySetException(new TimeoutException($"CDP {method} timed out after {timeout.TotalSeconds:0.#}s."));
                });
                return await tcs.Task;
            }
            finally
            {
                _pending.TryRemove(id, out _);
            }
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[256 * 1024];
            using var ms = new MemoryStream();
            try
            {
                while (_ws.State == WebSocketState.Open && !_cts.IsCancellationRequested)
                {
                    ms.SetLength(0);
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token);
                        if (result.MessageType == WebSocketMessageType.Close)
                            return;
                        ms.Write(buffer, 0, result.Count);
                    } while (!result.EndOfMessage);

                    try
                    {
                        HandleMessage(new ReadOnlyMemory<byte>(ms.GetBuffer(), 0, (int)ms.Length));
                    }
                    catch (Exception ex)
                    {
                        Logger.w(nameof(CdpConnection), "Failed to handle CDP message: " + ex.Message);
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                if (!_cts.IsCancellationRequested)
                    Logger.w(nameof(CdpConnection), "DevTools connection receive failed: " + ex.Message);
            }
            finally
            {
                MarkDisconnected();
            }
        }

        private void HandleMessage(ReadOnlyMemory<byte> data)
        {
            using var doc = JsonDocument.Parse(data);
            var root = doc.RootElement;
            if (root.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.Number)
            {
                var id = idElement.GetInt32();
                if (_pending.TryGetValue(id, out var pending))
                {
                    if (root.TryGetProperty("error", out var error))
                    {
                        var code = error.TryGetProperty("code", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt32() : 0;
                        var msg = error.TryGetProperty("message", out var m) ? m.GetString() ?? "" : "";
                        if (error.TryGetProperty("data", out var d))
                            msg += " " + d.ToString();
                        pending.Tcs.TrySetException(new CdpException(pending.Method, code, msg));
                    }
                    else if (root.TryGetProperty("result", out var res))
                        pending.Tcs.TrySetResult(res.Clone());
                    else
                        pending.Tcs.TrySetResult(_emptyObject);
                }
                return;
            }

            if (root.TryGetProperty("method", out var methodElement))
            {
                var method = methodElement.GetString() ?? "";
                var parameters = root.TryGetProperty("params", out var p) ? p.Clone() : _emptyObject;
                string? sessionId = root.TryGetProperty("sessionId", out var s) ? s.GetString() : null;
                _events.Writer.TryWrite(new CdpEvent(method, parameters, sessionId));
            }
        }

        private async Task DispatchLoopAsync()
        {
            try
            {
                await foreach (var ev in _events.Reader.ReadAllAsync())
                {
                    try
                    {
                        OnEvent?.Invoke(ev);
                    }
                    catch (Exception ex)
                    {
                        Logger.e(nameof(CdpConnection), $"CDP event handler for {ev.Method} failed: {ex.Message}", ex);
                    }
                }
            }
            catch (Exception ex)
            {
                Logger.e(nameof(CdpConnection), "CDP dispatch loop failed: " + ex.Message, ex);
            }
        }

        private void MarkDisconnected()
        {
            if (Interlocked.Exchange(ref _disconnected, 1) != 0)
                return;
            _events.Writer.TryComplete();
            _outgoing.Writer.TryComplete();
            while (_outgoing.Reader.TryRead(out var queued))
                queued.Tcs.TrySetException(new InvalidOperationException("DevTools connection is closed."));
            foreach (var pending in _pending.Values)
                pending.Tcs.TrySetException(new InvalidOperationException("DevTools connection is closed."));
            try
            {
                OnDisconnected?.Invoke();
            }
            catch (Exception ex)
            {
                Logger.e(nameof(CdpConnection), "OnDisconnected handler failed: " + ex.Message, ex);
            }
        }

        public void Dispose()
        {
            try { _cts.Cancel(); } catch { }
            try
            {
                if (_ws.State == WebSocketState.Open)
                    _ws.Abort();
            }
            catch { }
            MarkDisconnected();
            try { _ws.Dispose(); } catch { }
        }
    }

    internal static class JsonExt
    {
        public static string? Str(this JsonElement el, string name)
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v))
            {
                if (v.ValueKind == JsonValueKind.String)
                    return v.GetString();
                if (v.ValueKind == JsonValueKind.Number)
                    return v.GetRawText();
            }
            return null;
        }
        public static double? Num(this JsonElement el, string name)
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v))
            {
                if (v.ValueKind == JsonValueKind.Number)
                    return v.GetDouble();
                if (v.ValueKind == JsonValueKind.String && double.TryParse(v.GetString(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d))
                    return d;
            }
            return null;
        }
        public static bool? Bool(this JsonElement el, string name)
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v))
            {
                if (v.ValueKind == JsonValueKind.True) return true;
                if (v.ValueKind == JsonValueKind.False) return false;
            }
            return null;
        }
        public static JsonElement? Obj(this JsonElement el, string name)
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.Object || v.ValueKind == JsonValueKind.Array))
                return v;
            return null;
        }
    }
}
