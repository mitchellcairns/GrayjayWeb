using System.Text.Json;
using Grayjay.ClientServer.Models;
using Grayjay.ClientServer.Settings;
using Grayjay.ClientServer.States;
using Grayjay.Desktop.POC.Port.States;
using Grayjay.Engine.Models;
using Grayjay.Engine.Models.Detail;
using Grayjay.Engine.Models.Feed;
using Grayjay.Engine.Pagers;
using Microsoft.AspNetCore.Mvc;

namespace Grayjay.ClientServer.Controllers
{
    [Route("[controller]/[action]")]
    public class SearchController : ControllerBase
    {
        public class SearchState
        {
            public IPager<PlatformContent> SearchPager { get; set; }
        }

        private IPager<PlatformContent> EnsureSearchPager() => this.State().SearchState.SearchPager ?? throw new BadHttpRequestException("No search loaded");

        [HttpPost]
        public PagerResult<PlatformContent> SearchLoadLazy([FromBody]SearchModel model)
        {
            var search = model.Type switch
            {
                ContentType.UNKNOWN => StatePlatform.SearchLazy(model.Query, null, model.Order, model.Filters, model.ExcludePlugins),
                ContentType.MEDIA => StatePlatform.SearchLazy(model.Query, null, model.Order, model.Filters, model.ExcludePlugins),
                ContentType.CHANNEL => StatePlatform.SearchChannelsLazy(model.Query, model.ExcludePlugins),
                ContentType.PLAYLIST => StatePlatform.SearchPlaylistsLazy(model.Query, model.ExcludePlugins),
                _ => throw new NotImplementedException()
            };
            this.State().SearchState.SearchPager = search;
            // [GrayjayWeb] A source that finishes while the lazy pager is being built is briefly in neither its placeholders
            // nor its results (Grayjay.Engine MultiRefreshPager drops it from "pending" before adding its pager), so the
            // first page could come back empty and show "No results" for a search that had some. Give it a moment.
            var result = search.AsPagerResult();
            var waited = System.Diagnostics.Stopwatch.StartNew();
            while (result.Results.Length == 0 && waited.ElapsedMilliseconds < 400)
            {
                Thread.Sleep(20);
                result = search.AsPagerResult();
            }
            return result;
        }

        /// <summary>[GrayjayWeb] The current page of this window's search, without advancing it. The app polls this when
        /// the WebSocket update that replaces "loading" placeholders with results didn't reach it.</summary>
        [HttpGet]
        public PagerResult<PlatformContent> SearchCurrent()
        {
            var search = EnsureSearchPager();
            lock (search)
                return search.AsPagerResult();
        }

        [HttpGet]
        public PagerResult<PlatformContent> SearchNextPage()
        {
            try
            {
                lock (this.State().SearchState.SearchPager)
                {
                    var search = EnsureSearchPager();
                    search.NextPage();
                    return search.AsPagerResult();
                }
            }
            catch(Exception ex)
            {
                return new PagerResult<PlatformContent>()
                {
                    Results = new PlatformVideo[0],
                    HasMore = false,
                    Exception = ex.Message
                };
            }
        }

        [HttpGet]
        public ActionResult<IEnumerable<string>> SearchSuggestions(string query)
        {
            return Ok(StatePlatform.SearchSuggestions(query));
        }


        [HttpGet]
        public ActionResult<bool> IsContentDetailsUrl(string url)
        {
            return Ok(StatePlatform.IsContentDetailsUrl(url));
        }

        [HttpGet]
        public ActionResult RemoveAllPreviousSearches()
        {
            StateSearch.Instance.RemoveAllPreviousSearches();
            return Ok();
        }

        [HttpGet]
        public ActionResult RemovePreviousSearch(string query)
        {
            StateSearch.Instance.RemovePreviousSearch(query);
            return Ok();
        }

        [HttpGet]
        public ActionResult AddPreviousSearch(string query)
        {
            if (query == null)
                return NotFound();

            if (!GrayjaySettings.Instance.Search.SearchHistory)
                return Ok();
                
            StateSearch.Instance.AddPreviousSearch(query);
            return Ok();
        }

        [HttpGet]
        public ActionResult<IEnumerable<string>> PreviousSearches()
        {
            return Ok(StateSearch.Instance.PreviousSearches);
        }


        public class SearchModel
        {
            public ContentType Type { get; set; }
            public string Query { get; set; }
            public string Order { get; set; }
            public Dictionary<string, string[]> Filters { get; set; }
            public List<string> ExcludePlugins { get; set; }
        }
    }
}
