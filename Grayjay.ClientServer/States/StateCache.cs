using Dapper;
using Grayjay.ClientServer.Database;
using Grayjay.ClientServer.Database.Indexes;
using Grayjay.ClientServer.Store;
using Grayjay.Desktop.POC;
using Grayjay.Desktop.POC.Port.States;
using Grayjay.Engine.Models.Feed;
using Grayjay.Engine.Pagers;
using Microsoft.Extensions.Logging;
using System.Diagnostics;

namespace Grayjay.ClientServer.States
{
    public class StateCache
    {
        private static readonly string TAG = "StateCache";

        private static readonly ManagedDBStore<DBSubscriptionCacheIndex, PlatformContent> _subscriptionCache =
            new ManagedDBStore<DBSubscriptionCacheIndex, PlatformContent>(DBSubscriptionCacheIndex.TABLE_NAME)
            .Load();

        public static void Clear()
        {
            _subscriptionCache.DeleteAll();
        }

        /// <summary>
        /// [GrayjayWeb] The cache only ever grew (upstream issue #972): every feed refresh added items and nothing removed
        /// them, including channels you'd unsubscribed from. Keeps the newest <see cref="MaxCachedPerChannel"/> items of
        /// each subscribed channel and drops the rest. (The feed only reads subscribed channels' items, so nothing visible
        /// goes away; anything older comes back from the source when you scroll that far.)
        /// </summary>
        public const int MaxCachedPerChannel = 200;
        private static int _pruning = 0;

        public static int Prune()
        {
            if (Interlocked.Exchange(ref _pruning, 1) == 1) return 0;
            try
            {
                var subs = StateSubscriptions.GetSubscriptions();
                var keep = subs
                    .SelectMany(s => new[] { s.Channel?.Url }.Concat(s.Channel?.UrlAlternatives ?? new List<string>()))
                    .Where(u => !string.IsNullOrEmpty(u))
                    .Distinct()
                    .ToList();
                var table = DBSubscriptionCacheIndex.TABLE_NAME;
                var watch = Stopwatch.StartNew();
                var (before, removed) = StateApp.Connection.SQL(conn =>
                {
                    var count = conn.ExecuteScalar<long>($"SELECT COUNT(*) FROM \"{table}\"");
                    using var tx = conn.BeginTransaction();
                    // Items cached without a plugin ID break the feed (upstream issue #1030); they come back properly on refresh.
                    // (Only when some rows do have one: if the stored format ever changed, this must not wipe everything.)
                    const string noPlugin = "json_extract(CAST(Serialized AS TEXT), '$.ID.PluginID') IS NULL";
                    var withoutPlugin = conn.ExecuteScalar<long>($"SELECT COUNT(*) FROM \"{table}\" WHERE {noPlugin}", transaction: tx);
                    int deleted = withoutPlugin > 0 && withoutPlugin < count
                        ? conn.Execute($"DELETE FROM \"{table}\" WHERE {noPlugin}", transaction: tx) : 0;
                    // No subscriptions at all is more likely a load problem than a choice: don't wipe the cache for it.
                    if (keep.Count > 0)
                    {
                        conn.Execute("CREATE TEMP TABLE IF NOT EXISTS gj_keep_channels (url TEXT PRIMARY KEY)", transaction: tx);
                        conn.Execute("DELETE FROM gj_keep_channels", transaction: tx);
                        conn.Execute("INSERT OR IGNORE INTO gj_keep_channels (url) VALUES (@u)", keep.Select(u => new { u }), tx);
                        deleted += conn.Execute($"DELETE FROM \"{table}\" WHERE ChannelUrl IS NULL OR ChannelUrl NOT IN (SELECT url FROM gj_keep_channels)", transaction: tx);
                    }
                    deleted += conn.Execute($@"DELETE FROM ""{table}"" WHERE ID IN (
                        SELECT ID FROM (SELECT ID, ROW_NUMBER() OVER (PARTITION BY ChannelUrl ORDER BY DateTime DESC, ID DESC) AS rn FROM ""{table}"")
                        WHERE rn > @max)", new { max = MaxCachedPerChannel }, tx);
                    tx.Commit();
                    return (count, deleted);
                });
                Logger.i(TAG, $"Subscription cache: removed {removed} of {before} items ({keep.Count} subscribed channel addresses, {watch.ElapsedMilliseconds}ms)");
                // Deleted rows leave free pages behind; give a big clean-up's space back to the disk.
                if (removed > 10_000)
                {
                    try { StateApp.Connection.SQL(conn => conn.Execute("VACUUM")); }
                    catch (Exception ex) { Logger.w(TAG, "Couldn't compact the database after pruning: " + ex.Message); }
                }
                return removed;
            }
            catch (Exception ex)
            {
                Logger.e(TAG, "Failed to prune the subscription cache", ex);
                return 0;
            }
            finally { Interlocked.Exchange(ref _pruning, 0); }
        }

        private static Timer? _pruneTimer;
        /// <summary>[GrayjayWeb] Prunes a few minutes after start, then twice a day (the server stays on for weeks).</summary>
        public static void StartPruning()
        {
            _pruneTimer ??= new Timer(_ => Prune(), null, TimeSpan.FromMinutes(3), TimeSpan.FromHours(12));
        }

        public static void ClearToday()
        {
            var today = _subscriptionCache.QueryGreater(nameof(DBSubscriptionCacheIndex.DateTime), DateTime.Now.Subtract(DateTime.Now.TimeOfDay));
            foreach (var content in today)
            {
                _subscriptionCache.Delete(content);
            }
        }

        public static IPager<PlatformContent> GetChannelCachePager(string channelUrl)
        {
            return _subscriptionCache.QueryPager(nameof(DBSubscriptionCacheIndex.ChannelUrl), channelUrl, 20, it => it.Object);
        }

        public static IPager<PlatformContent> GetAllChannelCachePager(IEnumerable<string> channelUrls)
        {
            return _subscriptionCache.QueryInPager(nameof(DBSubscriptionCacheIndex.ChannelUrl), channelUrls, 20, it => it.Object);
        }

        public static IPager<PlatformContent> GetChannelCachePager(IEnumerable<string> channelUrls, int pageSize = 20)
        {
            var pagers = new MultiChronoContentPager(
                channelUrls.Select(url => _subscriptionCache.QueryPager(nameof(DBSubscriptionCacheIndex.ChannelUrl), url, pageSize, it => it.Object)),
                false, pageSize);

            return new DedupContentPager(pagers, StatePlatform.GetEnabledClients().Select(client => client.ID));
        }

        public static DedupContentPager GetSubscriptionCachePager()
        {
            Logger.i(TAG, "Subscriptions CachePager get subscriptions");
            var subs = StateSubscriptions.GetSubscriptions();
            Logger.i(TAG, "Subscriptions CachePager polycentric urls");
            var allUrls = subs
                .Select(sub =>
                {
                    var otherUrls = new List<string>();//PolycentricCache.Instance.GetCachedProfile(sub.Channel.Url)?.Profile?.OwnedClaims?.Select(c => c.Claim.ResolveChannelUrl()).Where(url => url != null).Select(url => url!).ToList() ?? new List<string>();
                    return otherUrls.Contains(sub.Channel.Url) ? otherUrls : new List<string> { sub.Channel.Url };
                })
                .SelectMany(urls => urls)
                .Distinct()
                .Where(url => StatePlatform.HasChannelClientFor(url))
                .ToList();

            Logger.i(TAG, "Subscriptions CachePager get pagers");
            List<IPager<PlatformContent>> pagers;

            var timeCacheRetrieving = Stopwatch.StartNew();
            try
            {
                pagers = new List<IPager<PlatformContent>>
            {
                GetAllChannelCachePager(allUrls)
            };
            }
            finally
            {
                timeCacheRetrieving.Stop();
                Logger.i(TAG, $"Subscriptions CachePager compiling (retrieved in {timeCacheRetrieving.ElapsedMilliseconds}ms)");
            }

            var pager = new MultiChronoContentPager(pagers, false, 20);
            pager.Initialize();
            Logger.i(TAG, "Subscriptions CachePager compiled");
            return new DedupContentPager(pager, StatePlatform.GetEnabledClients().Select(client => client.ID));
        }

        public static DBSubscriptionCacheIndex? GetCachedContent(string url)
        {
            return _subscriptionCache.Query(nameof(DBSubscriptionCacheIndex.Url), url).FirstOrDefault();
        }


        public static List<PlatformContent> CacheContents(IEnumerable<PlatformContent> contents, bool doUpdate = false)
        {
            return contents.Where(content => CacheContent(content, doUpdate)).ToList();
        }

        public static bool CacheContent(PlatformContent content, bool doUpdate = false)
        {
            if (string.IsNullOrEmpty(content.Author.Url))
            {
                return false;
            }
            // [GrayjayWeb] An item without a plugin ID crashed the cached feed for everyone (upstream issue #1030).
            if (string.IsNullOrEmpty(content.ID?.PluginID))
                return false;

            var serialized = content;//SerializedPlatformContent.FromContent(content);
            var existing = GetCachedContent(content.Url);

            if (existing != null && doUpdate)
            {
                _subscriptionCache.Update(existing.ID, serialized);
                return false;
            }
            else if (existing == null)
            {
                _subscriptionCache.Insert(serialized);
                return true;
            }

            return false;
        }

        public static IPager<PlatformContent> CachePagerResults(IPager<PlatformContent> pager, Action<PlatformContent>? onNewCacheHit = null)
        {
            var res = new ChannelContentCachePager(pager, onNewCacheHit);
            return res;
        }

        private class ChannelContentCachePager : IPager<PlatformContent>
        {
            private readonly IPager<PlatformContent> _pager;
            private readonly Action<PlatformContent>? _onNewCacheItem;
            public string ID { get; set; } = Guid.NewGuid().ToString();

            public ChannelContentCachePager(IPager<PlatformContent> pager, Action<PlatformContent>? onNewCacheItem = null)
            {
                _pager = pager;
                _onNewCacheItem = onNewCacheItem;

                var results = _pager.GetResults();

                Logger.i(TAG, $"Caching {results.Length} subscription initial results [{_pager.GetHashCode()}]");

                StateApp.ThreadPool.Run(() =>
                {
                    try
                    {
                        var newCacheItems = CacheContents(results, true);

                        foreach (var item in newCacheItems)
                            _onNewCacheItem?.Invoke(item);
                        //_onNewCacheItem?.InvokeRange(newCacheItems);
                    }
                    catch (Exception e)
                    {
                        Logger.e(TAG, "Failed to cache videos.", e);
                    }
                });
            }

            public bool HasMorePages() => _pager.HasMorePages();

            public void NextPage()
            {
                _pager.NextPage();
                var results = _pager.GetResults();

                StateApp.ThreadPool.Run(() =>
                {
                    try
                    {
                        var timeCacheRetrieving = Stopwatch.StartNew();

                        var newCacheItems = CacheContents(results, true);

                        timeCacheRetrieving.Stop();
                        Logger.i(TAG, $"Caching {results.Length} subscription results, updated {newCacheItems.Count} ({timeCacheRetrieving.ElapsedMilliseconds}ms)");
                    }
                    catch (Exception e)
                    {
                        Logger.e(TAG, $"Failed to cache {results.Length} videos.", e);
                    }
                });
            }

            public PlatformContent[] GetResults() => _pager.GetResults();
        }
    }
}
