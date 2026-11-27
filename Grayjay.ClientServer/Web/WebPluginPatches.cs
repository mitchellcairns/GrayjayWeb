using Grayjay.Desktop.POC;

namespace Grayjay.ClientServer.Web
{
    /// <summary>
    /// [GrayjayWeb] Small fixes to official plugin scripts, applied each time a plugin starts (so plugin updates are
    /// patched too), after the engine has checked the original script's signature (engine-plugin-script-patch in
    /// Grayjay.Web.Host/UpstreamPatches hands the script to <see cref="Apply"/>). Each is an exact find/replace; when an update changes that code (e.g. FUTO fixed it), the find no
    /// longer matches and the patch does nothing. Remove a patch once the plugin no longer needs it.
    /// </summary>
    public static class WebPluginPatches
    {
        private record Patch(string Name, string Find, string Replace);

        private const string TwitchId = "c0f315f9-0992-4508-a061-f2738724c331";

        private static readonly Dictionary<string, Patch[]> _patches = new()
        {
            [TwitchId] =
            [
                // Twitch search (videos and channels) asks for each channel's most-viewed clip, which the plugin never
                // uses. Twitch's API often fails that one field ("service error" on topClip) and the plugin then
                // rejects the whole page, so searches showed "Couldn't load from Twitch". Don't ask for it.
                new("twitch-search-topclip",
                    " topClip: clips(first: 1 criteria: { sort: VIEWS_DESC }) { edges { node { ...searchForFeaturedClipFragment } } }",
                    ""),
                // ...and drop its fragment, which GraphQL rejects once nothing uses it.
                new("twitch-search-clip-fragment",
                    " fragment searchForFeaturedClipFragment on Clip { id title durationSeconds thumbnailURL slug }",
                    ""),
            ],
        };

        private static readonly HashSet<string> _reported = new();

        public static void Install() =>
            AppDomain.CurrentDomain.SetData("GrayjayWeb.PluginScriptPatch", new Func<string, string, string>(Apply));

        public static string Apply(string pluginId, string script)
        {
            if (string.IsNullOrEmpty(script) || !_patches.TryGetValue(pluginId, out var patches))
                return script;
            foreach (var p in patches)
            {
                var applied = script.Contains(p.Find);
                if (applied)
                    script = script.Replace(p.Find, p.Replace);
                lock (_reported)
                {
                    if (_reported.Add(p.Name))
                        Logger.i(nameof(WebPluginPatches), applied
                            ? $"Plugin patch {p.Name} applied"
                            : $"Plugin patch {p.Name} no longer matches the plugin; it may not be needed any more");
                }
            }
            return script;
        }
    }
}
