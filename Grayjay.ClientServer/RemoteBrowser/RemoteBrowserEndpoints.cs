using Grayjay.Desktop.POC;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Grayjay.ClientServer.RemoteBrowser
{
    /// <summary>
    /// HTTP / WebSocket endpoints of the remote login browser (no auth here, the host puts them behind its auth middleware).
    ///
    /// <para><b>GET /RemoteBrowser/Sessions</b> → <c>[{id,title,url,width,height,mobile}]</c></para>
    /// <para><b>POST /RemoteBrowser/{id}/Close</b> → closes a session (same as the "close" message).</para>
    /// <para><b>GET /RemoteBrowser/{id}/Stream</b> (WebSocket, JSON text messages). 404 if the session does not exist.</para>
    /// <para>Server → client:</para>
    /// <list type="bullet">
    /// <item><c>{"type":"info","id","title","url","width","height","dpr","mobile"}</c> once on connect</item>
    /// <item><c>{"type":"frame","data":"&lt;base64 jpeg&gt;","width":W,"height":H}</c> (W/H = viewport CSS px the frame represents; frames are coalesced per client, ~20fps max)</item>
    /// <item><c>{"type":"url","url":"...","canGoBack":bool}</c> on navigation (and on connect)</item>
    /// <item><c>{"type":"viewport","width","height","dpr","mobile"}</c> after a resize</item>
    /// <item><c>{"type":"ytAccounts","accounts":[{"index","name","handle","subtitle","thumbnail","selected"}]}</c> while on
    /// YouTube's channel_switcher (empty list = nothing extracted, show the live page). Hide the picker when a "url" message
    /// arrives for a non channel_switcher URL.</item>
    /// <item><c>{"type":"closed"}</c> then the socket is closed</item>
    /// </list>
    /// <para>Client → server (coordinates in viewport CSS px):</para>
    /// <list type="bullet">
    /// <item><c>{"type":"pointer","action":"down|move|up|cancel","x","y","button":"left|right|middle","pointerType":"touch|mouse|pen","id"?:touchId,"modifiers"?}</c></item>
    /// <item><c>{"type":"wheel","x","y","deltaX","deltaY"}</c></item>
    /// <item><c>{"type":"key","action":"down|up|press","key","code"?,"keyCode"?,"modifiers"?}</c> (modifiers = CDP bitmask Alt=1, Ctrl=2, Meta=4, Shift=8;
    /// printable keys sent as key events also insert text, so don't send them as "text" too)</item>
    /// <item><c>{"type":"text","text":"..."}</c> → Input.insertText (soft keyboards / IME)</item>
    /// <item><c>{"type":"resize","width","height","dpr"}</c></item>
    /// <item><c>{"type":"back"}</c>, <c>{"type":"forward"}</c>, <c>{"type":"reload"}</c>, <c>{"type":"close"}</c> (user cancel)</item>
    /// <item><c>{"type":"ytSelectAccount","index":n}</c>, <c>{"type":"ytRefresh"}</c>, <c>{"type":"ping"}</c></item>
    /// </list>
    /// </summary>
    public static class RemoteBrowserEndpoints
    {
        public const string BasePath = "/RemoteBrowser";

        public static IEndpointRouteBuilder Map(IEndpointRouteBuilder app)
        {
            app.MapGet(BasePath + "/Sessions", () =>
                Results.Json(RemoteBrowserManager.GetSessions().Select(s => s.Describe()).ToList()));

            app.MapPost(BasePath + "/{id}/Close", async (HttpContext context) =>
            {
                var id = context.Request.RouteValues["id"]?.ToString();
                var session = id != null ? RemoteBrowserManager.GetSession(id) : null;
                if (session == null)
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }
                _ = session.CloseInternalAsync("closed via HTTP");
                context.Response.StatusCode = StatusCodes.Status200OK;
                await context.Response.WriteAsync("");
            });

            app.Map(BasePath + "/{id}/Stream", async (HttpContext context) =>
            {
                var id = context.Request.RouteValues["id"]?.ToString();
                if (!context.WebSockets.IsWebSocketRequest)
                {
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    await context.Response.WriteAsync("WebSocket required");
                    return;
                }
                var session = id != null ? RemoteBrowserManager.GetSession(id) : null;
                if (session == null)
                {
                    context.Response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }

                using var socket = await context.WebSockets.AcceptWebSocketAsync();
                try
                {
                    await session.HandleViewerAsync(socket, context.RequestAborted);
                }
                catch (Exception ex)
                {
                    Logger.w(nameof(RemoteBrowserEndpoints), $"Remote browser stream for {id} ended with error: {ex.Message}");
                }
            });

            return app;
        }
    }
}
