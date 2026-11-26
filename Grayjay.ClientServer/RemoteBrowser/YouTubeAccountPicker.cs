using System.Text.Json;
using System.Text.RegularExpressions;

namespace Grayjay.ClientServer.RemoteBrowser
{
    /// <summary>
    /// Extracts the channel / account list from YouTube's channel switcher page
    /// (<c>https://www.youtube.com/channel_switcher</c> or <c>https://m.youtube.com/channel_switcher</c>), so the web
    /// client can render a native, finger friendly picker instead of making the user poke at a tiny remote page.
    ///
    /// <para>Everything runs inside the page through <c>Runtime.evaluate</c> and is written defensively, because
    /// YouTube's JSON shape changes regularly. Sources, in order (the first one that yields accounts wins):</para>
    /// <list type="number">
    /// <item><b><c>window.ytInitialData</c></b> (and <c>ytInitialData</c> embedded as JSON in inline scripts on
    /// m.youtube.com). It is walked generically. Pass 1 collects objects that have an <c>accountName</c> property
    /// (the <c>accountItem</c> / <c>accountItemRenderer</c> shape), pass 2 (only when pass 1 finds nothing) collects
    /// objects with a <c>title</c>/<c>name</c>-ish text plus a thumbnail. An object only counts when a switch URL can
    /// be found within it (searched up to 7 levels, not descending into arrays): a string under
    /// <c>signinUrl</c>/<c>url</c>/<c>webCommandMetadata.url</c>/<c>href</c> that looks like
    /// <c>/signin?action_handle_signin=true&amp;authuser=N&amp;pageid=...&amp;next=...</c> (matches
    /// <c>action_handle_signin</c>, <c>pageid=</c>, <c>authuser=</c> or <c>/signin?</c>), excluding AddSession,
    /// ServiceLogin, logout and channel creation links. An item with a <c>selectActiveIdentityEndpoint</c> but no
    /// URL is still accepted (it is then selected by clicking). Texts are read from <c>simpleText</c>,
    /// <c>runs[].text</c> or <c>content</c>; thumbnails from <c>thumbnails[]</c>/<c>sources[]</c> (largest).
    /// Handle = <c>channelHandle</c> (or an "@..." byline), subtitle = <c>accountByline</c>/<c>byline</c>/<c>subtitle</c>,
    /// falling back to the e-mail of the enclosing <c>googleAccountHeaderRenderer</c> section header, selected =
    /// <c>isSelected</c>/<c>selected</c>.</item>
    /// <item><b>Innertube <c>POST /youtubei/v1/account/accounts_list</c></b>, called from the page with its own
    /// <c>ytcfg</c> (INNERTUBE_CONTEXT, API key, client name/version, SESSION_INDEX, DELEGATED_SESSION_ID) and a
    /// SAPISIDHASH Authorization header computed from the SAPISID cookie; the response
    /// (<c>actions[].getMultiPageMenuAction.menu.multiPageMenuRenderer.sections[].accountSectionListRenderer
    /// .contents[].accountItemSectionRenderer.contents[].accountItem</c>) is walked with the same generic walker.</item>
    /// <item><b>DOM scraping</b> of <c>ytd-account-item-renderer</c>, <c>ytm-account-item-renderer</c>,
    /// <c>yt-account-item-view-model</c> and links containing <c>action_handle_signin</c>/<c>pageid=</c>.
    /// The matched elements are kept in <c>window.__grayjayYtAccountEls</c> for click-to-select.</item>
    /// </list>
    /// <para>Selecting: navigate to the item's switch URL when known, otherwise click the matching DOM element
    /// (by DOM index, then by account name text).</para>
    /// </summary>
    public static class YouTubeAccountPicker
    {
        private static readonly Regex _switcherRegex = new Regex(@"^https?://(www|m)\.youtube\.com/channel_switcher", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        public static bool IsSwitcherUrl(string? url) => url != null && _switcherRegex.IsMatch(url);

        public class Account
        {
            public int Index { get; set; }
            public string Name { get; set; } = "";
            public string Handle { get; set; } = "";
            public string Subtitle { get; set; } = "";
            public string Thumbnail { get; set; } = "";
            public bool Selected { get; set; }
            public string? Url { get; set; }
            public int DomIndex { get; set; } = -1;
            public string Source { get; set; } = "";
        }

        public static List<Account> Parse(JsonElement? value)
        {
            var list = new List<Account>();
            if (value == null || value.Value.ValueKind != JsonValueKind.Object)
                return list;
            var accounts = value.Value.Obj("accounts");
            if (accounts == null || accounts.Value.ValueKind != JsonValueKind.Array)
                return list;
            var source = value.Value.Str("source") ?? "";
            foreach (var item in accounts.Value.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                    continue;
                var name = item.Str("name") ?? "";
                if (string.IsNullOrWhiteSpace(name))
                    continue;
                list.Add(new Account()
                {
                    Index = list.Count,
                    Name = name.Trim(),
                    Handle = (item.Str("handle") ?? "").Trim(),
                    Subtitle = (item.Str("subtitle") ?? "").Trim(),
                    Thumbnail = item.Str("thumbnail") ?? "",
                    Selected = item.Bool("selected") ?? false,
                    Url = string.IsNullOrWhiteSpace(item.Str("url")) ? null : item.Str("url"),
                    DomIndex = (int)(item.Num("domIndex") ?? -1),
                    Source = source
                });
                if (list.Count >= 100)
                    break;
            }
            return list;
        }

        public static string BuildClickScript(Account account)
        {
            return "(" + ClickScriptFunction + ")(" + JsonSerializer.Serialize(account.DomIndex) + "," + JsonSerializer.Serialize(account.Name) + ")";
        }

        private const string ClickScriptFunction = """
            function(domIndex, name) {
                const fire = (el) => {
                    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
                    const target = el.querySelector && (el.querySelector('a[href], button, [role=button], tp-yt-paper-item') || el) || el;
                    target.click();
                    return true;
                };
                const els = window.__grayjayYtAccountEls;
                if (Array.isArray(els) && domIndex >= 0 && els[domIndex] && els[domIndex].isConnected)
                    return fire(els[domIndex]);
                if (!name) return false;
                const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const wanted = norm(name);
                const candidates = Array.from(document.querySelectorAll('ytd-account-item-renderer, ytm-account-item-renderer, yt-account-item-view-model, a[href], button, [role=button], [role=menuitem], [role=option], tp-yt-paper-item, [tabindex]'))
                    .filter(el => norm(el.innerText).includes(wanted));
                if (!candidates.length) return false;
                candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
                return fire(candidates[0]);
            }
            """;

        /// <summary>
        /// Script evaluated with awaitPromise + returnByValue. Returns
        /// <c>{ source, accounts: [{ name, handle, subtitle, thumbnail, selected, url, domIndex }] }</c>.
        /// </summary>
        public const string ExtractScript = """
            (async () => {
                const text = (v) => {
                    if (v == null) return '';
                    if (typeof v === 'string') return v;
                    if (typeof v !== 'object') return '';
                    if (typeof v.simpleText === 'string') return v.simpleText;
                    if (Array.isArray(v.runs)) return v.runs.map(r => (r && typeof r.text === 'string') ? r.text : '').join('');
                    if (typeof v.content === 'string') return v.content;
                    if (typeof v.text === 'string') return v.text;
                    if (v.text && typeof v.text === 'object') return text(v.text);
                    return '';
                };
                const fixUrl = (u) => (typeof u === 'string' && u.startsWith('//')) ? ('https:' + u) : (u || '');
                const thumb = (v, depth) => {
                    depth = depth || 0;
                    if (!v || typeof v !== 'object' || depth > 4) return '';
                    const list = Array.isArray(v.thumbnails) ? v.thumbnails : (Array.isArray(v.sources) ? v.sources : (Array.isArray(v) ? v : null));
                    if (list && list.length) {
                        let best = list[0];
                        for (const t of list) if (t && (t.width || 0) > ((best && best.width) || 0)) best = t;
                        return fixUrl(best && best.url);
                    }
                    for (const k of ['thumbnail', 'image', 'avatar', 'accountPhoto', 'avatarViewModel', 'decoratedAvatarViewModel']) {
                        if (v[k]) { const r = thumb(v[k], depth + 1); if (r) return r; }
                    }
                    return '';
                };
                const GOOD = /action_handle_signin|[?&]pageid=|[?&]authuser=|\/signin\?/i;
                const BAD = /AddSession|ServiceLogin|\/logout|create_channel|channel_creation|\/create\b|SignOutOptions/i;
                const findUrl = (o, depth) => {
                    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 7) return null;
                    for (const k of ['signinUrl', 'url', 'href']) {
                        const v = o[k];
                        if (typeof v === 'string' && GOOD.test(v) && !BAD.test(v)) return v;
                    }
                    for (const k in o) {
                        const v = o[k];
                        if (v && typeof v === 'object') {
                            if (Array.isArray(v)) {
                                // supportedTokens: [{accountSigninToken: {signinUrl}}] is an array of tokens - search shallowly
                                if (k === 'supportedTokens' || k === 'commands') {
                                    for (const x of v) { const r = findUrl(x, depth + 1); if (r) return r; }
                                }
                                continue;
                            }
                            const r = findUrl(v, depth + 1);
                            if (r) return r;
                        }
                    }
                    return null;
                };
                const hasIdentityEndpoint = (o) => {
                    try { return JSON.stringify(o).includes('selectActiveIdentityEndpoint'); } catch (e) { return false; }
                };
                const firstText = (o, keys) => {
                    for (const k of keys) { const t = text(o[k]); if (t && t.trim()) return t.trim(); }
                    return '';
                };
                const walk = (root, mode) => {
                    const out = [];
                    const seen = new WeakSet();
                    const visit = (o, depth, ctx) => {
                        if (!o || typeof o !== 'object' || depth > 80 || seen.has(o)) return;
                        seen.add(o);
                        if (Array.isArray(o)) { for (const x of o) visit(x, depth + 1, ctx); return; }
                        const hdr = (o.header && (o.header.googleAccountHeaderRenderer || o.header.accountSectionHeaderRenderer)) || o.googleAccountHeaderRenderer;
                        if (hdr) ctx = { email: text(hdr.email) || text(hdr.name) || ctx.email };
                        let name = '';
                        if (mode === 1) name = ('accountName' in o) ? text(o.accountName).trim() : '';
                        else name = firstText(o, ['title', 'channelName', 'name', 'displayName']);
                        if (name) {
                            const url = findUrl(o, 0);
                            const photo = thumb(o.accountPhoto || o.thumbnail || o.avatar || o.channelThumbnail || o.image || o);
                            if ((url || hasIdentityEndpoint(o)) && (mode === 1 || photo)) {
                                let handle = firstText(o, ['channelHandle', 'handle', 'canonicalBaseUrl']);
                                let subtitle = firstText(o, ['accountByline', 'byline', 'subtitle', 'email', 'description']);
                                if (!handle && subtitle.startsWith('@')) { handle = subtitle; subtitle = ''; }
                                if (!subtitle && ctx.email) subtitle = ctx.email;
                                out.push({
                                    name, handle, subtitle,
                                    thumbnail: photo,
                                    selected: o.isSelected === true || o.selected === true || o.isCurrentAccount === true,
                                    url: url || null,
                                    domIndex: -1
                                });
                                return;
                            }
                        }
                        for (const k in o) visit(o[k], depth + 1, ctx);
                    };
                    visit(root, 0, { email: '' });
                    return out;
                };
                const dedupe = (list) => {
                    const seen = new Set();
                    return list.filter(a => { const key = (a.url || '') + '|' + a.name + '|' + a.handle; if (seen.has(key)) return false; seen.add(key); return true; });
                };
                const fromJson = (data) => {
                    if (!data || typeof data !== 'object') return [];
                    let list = dedupe(walk(data, 1));
                    if (!list.length) list = dedupe(walk(data, 2));
                    return list;
                };
                const result = { source: 'none', accounts: [], errors: [] };
                const take = (source, list) => { if (list && list.length && !result.accounts.length) { result.source = source; result.accounts = list; } };

                // 1) ytInitialData
                try {
                    let data = window.ytInitialData;
                    if (!data) {
                        for (const s of Array.from(document.querySelectorAll('script'))) {
                            const t = s.textContent || '';
                            const idx = t.indexOf('ytInitialData');
                            if (idx < 0) continue;
                            const m = t.match(/ytInitialData\s*=\s*'((?:\\'|[^'])*)'/);
                            if (m) { try { data = JSON.parse(m[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\'/g, "'")); } catch (e) {} }
                            if (!data) {
                                const start = t.indexOf('{', idx);
                                if (start >= 0) {
                                    let depth = 0, inStr = false, esc = false, end = -1;
                                    for (let i = start; i < t.length; i++) {
                                        const c = t[i];
                                        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
                                        if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
                                    }
                                    if (end > start) { try { data = JSON.parse(t.substring(start, end + 1)); } catch (e) {} }
                                }
                            }
                            if (data) break;
                        }
                    }
                    take('ytInitialData', fromJson(data));
                } catch (e) { result.errors.push('initialData: ' + e); }

                // 2) innertube account/accounts_list
                if (!result.accounts.length) {
                    try {
                        const yc = window.ytcfg;
                        const cfg = (k) => { try { if (yc && typeof yc.get === 'function') { const v = yc.get(k); if (v !== undefined) return v; } return yc && yc.data_ ? yc.data_[k] : undefined; } catch (e) { return undefined; } };
                        const context = cfg('INNERTUBE_CONTEXT');
                        if (context) {
                            const cookie = (n) => { const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n.replace(/[.$?*|{}()\[\]\\\/+^]/g, '\\$&') + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
                            const headers = { 'content-type': 'application/json' };
                            const cn = cfg('INNERTUBE_CONTEXT_CLIENT_NAME'); const cv = cfg('INNERTUBE_CONTEXT_CLIENT_VERSION') || (context.client && context.client.clientVersion);
                            if (cn) headers['x-youtube-client-name'] = String(cn);
                            if (cv) headers['x-youtube-client-version'] = String(cv);
                            const si = cfg('SESSION_INDEX'); if (si !== undefined && si !== null && si !== '') headers['x-goog-authuser'] = String(si);
                            const pid = cfg('DELEGATED_SESSION_ID'); if (pid) headers['x-goog-pageid'] = String(pid);
                            const vd = cfg('VISITOR_DATA') || (context.client && context.client.visitorData); if (vd) headers['x-goog-visitor-id'] = String(vd);
                            const sapisid = cookie('SAPISID') || cookie('__Secure-3PAPISID');
                            if (sapisid && window.crypto && crypto.subtle) {
                                const ts = Math.floor(Date.now() / 1000);
                                const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sapisid + ' ' + location.origin));
                                const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
                                headers['authorization'] = 'SAPISIDHASH ' + ts + '_' + hex;
                                headers['x-origin'] = location.origin;
                            }
                            const key = cfg('INNERTUBE_API_KEY');
                            const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
                            try {
                                const res = await fetch('/youtubei/v1/account/accounts_list?prettyPrint=false' + (key ? '&key=' + encodeURIComponent(key) : ''), {
                                    method: 'POST', credentials: 'include', headers, signal: ctrl.signal,
                                    body: JSON.stringify({ context, requestType: 'ACCOUNTS_LIST_REQUEST_TYPE_CHANNEL_SWITCHER', callCircumstance: 'SWITCHING_USERS_FULL' })
                                });
                                if (res.ok) take('accounts_list', fromJson(await res.json()));
                                else result.errors.push('accounts_list: HTTP ' + res.status);
                            } finally { clearTimeout(timer); }
                        }
                    } catch (e) { result.errors.push('accounts_list: ' + e); }
                }

                // 3) DOM
                try {
                    const els = Array.from(document.querySelectorAll('ytd-account-item-renderer, ytm-account-item-renderer, yt-account-item-view-model, a[href*="action_handle_signin"], a[href*="pageid="]'))
                        .filter((el, i, arr) => !arr.some(other => other !== el && other.contains(el)));
                    window.__grayjayYtAccountEls = els;
                    const domList = [];
                    els.forEach((el, i) => {
                        const q = (sel) => { const n = el.querySelector(sel); return n ? (n.innerText || n.textContent || '').trim() : ''; };
                        const lines = (el.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
                        const name = q('#channel-title, .account-name, [id*=title], yt-formatted-string') || lines[0] || '';
                        if (!name) return;
                        const a = (el.tagName === 'A' ? el : (el.querySelector('a[href]') || el.closest('a[href]')));
                        const href = a ? a.getAttribute('href') : null;
                        const img = el.querySelector('img');
                        let handle = lines.find(l => l.startsWith('@')) || '';
                        const subtitle = lines.find(l => l !== name && l !== handle) || '';
                        domList.push({
                            name, handle, subtitle,
                            thumbnail: img ? fixUrl(img.getAttribute('src') || img.src || '') : '',
                            selected: el.hasAttribute('selected') || el.getAttribute('aria-selected') === 'true' || !!el.querySelector('[aria-checked=true], .selected, #checkmark:not([hidden])'),
                            url: (href && GOOD.test(href) && !BAD.test(href)) ? href : null,
                            domIndex: i
                        });
                    });
                    if (!result.accounts.length) take('dom', domList);
                    else {
                        // attach DOM indices to JSON results so clicking can be used as a fallback
                        for (const acc of result.accounts) {
                            const match = domList.find(d => d.name === acc.name);
                            if (match) acc.domIndex = match.domIndex;
                        }
                    }
                } catch (e) { result.errors.push('dom: ' + e); }

                return result;
            })()
            """;
    }
}
