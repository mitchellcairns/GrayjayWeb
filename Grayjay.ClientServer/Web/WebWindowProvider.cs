namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Window provider for web mode. There is no local window: plugin login and captcha pages are rendered in a
    /// server-side Chromium and streamed to the PWA (the remote login browser), which is plugged in via <see cref="InterceptorFactory"/>.
    /// Native file/folder dialogs don't exist on the server; the PWA uses browser upload/download instead.
    /// </summary>
    public class WebWindowProvider : IWindowProvider
    {
        public delegate Task<IWindow> InterceptorWindowFactory(string title, string url, string userAgent, bool useMobileEmulation,
            string? injectJs, Action<InterceptorRequest> handler, CancellationToken cancellationToken);

        public static InterceptorWindowFactory? InterceptorFactory { get; set; }

        public Task<IWindow> CreateWindowAsync(string url, string title, int preferredWidth, int preferredHeight, int minimumWidth = 0, int minimumHeight = 0, Func<IWindow, Task> beforeLoad = null)
            => throw new NotSupportedException("Opening new windows is not supported in web mode.");

        public Task<IWindow> CreateInterceptorWindowAsync(string title, string url, string userAgent, bool useMobileEmulation, string? injectJs, Action<InterceptorRequest> handler, CancellationToken cancellationToken = default)
        {
            if (InterceptorFactory == null)
                throw new NotSupportedException("Sign-in needs the remote login browser, which is not available on this server (no Chrome, Edge or Chromium found).");
            return InterceptorFactory(title, url, userAgent, useMobileEmulation, injectJs, handler, cancellationToken);
        }

        public Task<string>? ShowDirectoryDialogAsync(CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Folder pickers are not available in web mode.");

        public Task<string?> ShowFileDialogAsync((string name, string pattern)[] filters, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("File pickers are not available in web mode. Upload the file from the app instead.");

        public Task<string?> ShowSaveFileDialogAsync(string name, (string name, string pattern)[] filters, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Save dialogs are not available in web mode. Downloads are saved through the browser instead.");
    }
}
