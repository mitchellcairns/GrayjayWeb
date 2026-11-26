using Grayjay.Desktop.POC;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;

namespace Grayjay.ClientServer.RemoteBrowser
{
    /// <summary>
    /// One connected web client watching a <see cref="RemoteBrowserSession"/>. Control messages are queued in order,
    /// frames are coalesced (only the newest pending frame is sent) so a slow client never builds up a backlog.
    /// </summary>
    internal sealed class RemoteBrowserViewer
    {
        public string Id { get; } = Guid.NewGuid().ToString("N").Substring(0, 8);
        public WebSocket Socket { get; }

        private readonly ConcurrentQueue<string> _control = new ConcurrentQueue<string>();
        private string? _pendingFrame;
        private readonly SemaphoreSlim _signal = new SemaphoreSlim(0, 1);
        private volatile bool _closeRequested;

        public RemoteBrowserViewer(WebSocket socket)
        {
            Socket = socket;
        }

        public void Enqueue(string message)
        {
            _control.Enqueue(message);
            Signal();
        }

        public void SetFrame(string message)
        {
            Interlocked.Exchange(ref _pendingFrame, message);
            Signal();
        }

        /// <summary>Flush queued messages, then close the socket.</summary>
        public void RequestClose()
        {
            _closeRequested = true;
            Signal();
        }

        private void Signal()
        {
            try
            {
                if (_signal.CurrentCount == 0)
                    _signal.Release();
            }
            catch (SemaphoreFullException)
            {
            }
        }

        public async Task SendLoopAsync(CancellationToken cancellationToken)
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested && Socket.State == WebSocketState.Open)
                {
                    await _signal.WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);

                    while (_control.TryDequeue(out var msg))
                        await SendTextAsync(msg, cancellationToken);

                    var frame = Interlocked.Exchange(ref _pendingFrame, null);
                    if (frame != null && !_closeRequested)
                        await SendTextAsync(frame, cancellationToken);

                    if (_closeRequested && _control.IsEmpty)
                    {
                        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                        try
                        {
                            await Socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "Session closed", timeout.Token);
                        }
                        catch { }
                        return;
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (Exception ex)
            {
                Logger.v(nameof(RemoteBrowserViewer), $"Viewer {Id} send loop ended: {ex.Message}");
            }
        }

        private async Task SendTextAsync(string message, CancellationToken cancellationToken)
        {
            var bytes = Encoding.UTF8.GetBytes(message);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            await Socket.SendAsync(bytes, WebSocketMessageType.Text, true, timeout.Token);
        }
    }
}
