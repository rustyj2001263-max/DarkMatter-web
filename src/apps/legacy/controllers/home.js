import escapeHtml from 'escape-html';

import cardBuilder from 'components/cardbuilder/cardBuilder';
import focusManager from 'components/focusManager';
import imageLoader from 'components/images/imageLoader';
import layoutManager from 'components/layoutManager';
import { playbackManager } from 'components/playback/playbackmanager';
import { appRouter } from 'components/router/appRouter';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import LibraryMenu from 'scripts/libraryMenu';
import { getBackdropShape } from 'components/cardbuilder/utils/shape';

import 'elements/emby-button/emby-button';
import 'elements/emby-itemscontainer/emby-itemscontainer';
import 'elements/emby-scroller/emby-scroller';
import 'styles/dmmHome.scss';

// Per-user display preferences written by the AI Smart Picks script
// (/mnt/user/appdata/ai-smart-picks/smart_picks.py); must match PREFS_ID / PREFS_CLIENT / PREFS_KEY_IDS there
const AI_PICKS_PREFS_ID = 'dmmAiSmartPicks';
const AI_PICKS_PREFS_CLIENT = 'dmm';
const AI_PICKS_PREFS_KEY = 'aiSmartPicks';
// Next movie in each collection the user has started, written by the same script (PREFS_KEY_UP_NEXT_MOVIES)
const UP_NEXT_MOVIES_PREFS_KEY = 'upNextMovies';

// JellyBridge libraries holding titles that are not in the library yet
const DISCOVER_MOVIES_LIBRARY = 'Discover Movies';
const DISCOVER_SHOWS_LIBRARY = 'Discover Shows';
const PLACEHOLDER_PATH_MARKER = '/JellyBridge/';

const MEDIA_TYPES = 'Movie,Series';
const ROW_LIMIT = 24;
const MIN_ROW_ITEMS = 3;
const CARD_FIELDS = 'PrimaryImageAspectRatio,MediaSourceCount';
const CARD_IMAGE_TYPES = 'Primary,Backdrop,Thumb';

function getRowCardsHtml(items) {
    return cardBuilder.getCardsHtml({
        items: items,
        shape: getBackdropShape(true),
        preferThumb: true,
        inheritThumb: false,
        showTitle: true,
        centerText: true,
        overlayPlayButton: true,
        showDetailsMenu: true,
        lazy: true,
        context: 'home',
        allowBottomPadding: false,
        lines: 1
    });
}

// Episodes need the series name as well as the episode title
function getEpisodeRowCardsHtml(items) {
    return cardBuilder.getCardsHtml({
        items: items,
        shape: getBackdropShape(true),
        preferThumb: true,
        inheritThumb: false,
        showTitle: true,
        showParentTitle: true,
        centerText: true,
        overlayPlayButton: true,
        showDetailsMenu: true,
        lazy: true,
        context: 'home',
        allowBottomPadding: false,
        lines: 2
    });
}

function fetchAiPicks(apiClient, prefsKey = AI_PICKS_PREFS_KEY) {
    const userId = apiClient.getCurrentUserId();

    return apiClient.getDisplayPreferences(AI_PICKS_PREFS_ID, userId, AI_PICKS_PREFS_CLIENT).then(prefs => {
        const ids = (prefs.CustomPrefs?.[prefsKey] || '').split(',').filter(Boolean);
        if (!ids.length) {
            return [];
        }

        return apiClient.getItems(userId, {
            Ids: ids.join(','),
            Fields: CARD_FIELDS,
            ImageTypeLimit: 1,
            EnableImageTypes: CARD_IMAGE_TYPES,
            EnableTotalRecordCount: false
        }).then(result => {
            // Keep the model's ranking and drop anything watched since the picks were generated
            const order = new Map(ids.map((id, index) => [id, index]));
            return result.Items
                .filter(item => !item.UserData?.Played)
                .sort((a, b) => order.get(a.Id) - order.get(b.Id));
        });
    }).catch(err => {
        console.error(`[DarkMatterHome] failed to load ${prefsKey}`, err);
        return [];
    });
}

function fetchContinueWatching(apiClient) {
    return apiClient.getResumableItems(apiClient.getCurrentUserId(), {
        Limit: ROW_LIMIT,
        Recursive: true,
        MediaTypes: 'Video',
        Fields: CARD_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: CARD_IMAGE_TYPES,
        EnableTotalRecordCount: false
    }).then(result => result.Items);
}

// Anime has its own libraries; any library with "anime" in its name gets the anime rows instead
function isAnimeLibrary(view) {
    return /anime/i.test(view.Name || '');
}

function fetchNextUpEpisodes(apiClient, anime) {
    const userId = apiClient.getCurrentUserId();

    // Asked per TV library so anime and regular shows each get their own row
    return apiClient.getUserViews({}, userId).then(result => Promise.all(
        result.Items
            .filter(view => view.CollectionType === 'tvshows' && isAnimeLibrary(view) === anime)
            .map(view => apiClient.getNextUpEpisodes({
                UserId: userId,
                ParentId: view.Id,
                Limit: ROW_LIMIT,
                Fields: `${CARD_FIELDS},Path`,
                ImageTypeLimit: 1,
                EnableImageTypes: CARD_IMAGE_TYPES,
                EnableTotalRecordCount: false,
                DisableFirstEpisode: false,
                // Episodes already in progress are shown in Continue Watching
                EnableResumable: false
            }).then(nextUp => nextUp.Items))
    )).then(lists => lists
        .flat()
        .filter(item => !item.Path?.includes(PLACEHOLDER_PATH_MARKER))
        .slice(0, ROW_LIMIT));
}

function getDateAdded(item) {
    // Series report when their newest episode arrived; movies only have their own date
    return item.DateLastMediaAdded || item.DateCreated || '';
}

// Newly added items from every anime or non-anime library of the given types ('movies', 'tvshows')
function fetchRecentMedia(apiClient, collectionTypes, anime) {
    const userId = apiClient.getCurrentUserId();

    // Query each library on its own: the server caps a combined "latest" list,
    // and JellyBridge adds placeholders so often that they would crowd out real additions
    return apiClient.getUserViews({}, userId).then(result => Promise.all(
        result.Items
            .filter(view => collectionTypes.includes(view.CollectionType) && isAnimeLibrary(view) === anime)
            .map(view => apiClient.getLatestItems({
                ParentId: view.Id,
                // New episodes are grouped into their series by the server
                IncludeItemTypes: view.CollectionType === 'movies' ? 'Movie' : 'Episode',
                Limit: ROW_LIMIT,
                Fields: `${CARD_FIELDS},Path,DateCreated,DateLastMediaAdded`,
                ImageTypeLimit: 1,
                EnableImageTypes: CARD_IMAGE_TYPES
            }))
    )).then(lists => lists
        .flat()
        .filter(item => !item.Path?.includes(PLACEHOLDER_PATH_MARKER))
        .sort((a, b) => getDateAdded(b).localeCompare(getDateAdded(a)))
        .slice(0, ROW_LIMIT));
}

function fetchLibraryItems(apiClient, libraryName) {
    const userId = apiClient.getCurrentUserId();

    return apiClient.getUserViews({}, userId).then(result => {
        const library = result.Items.find(view => view.Name === libraryName);
        if (!library) {
            return [];
        }

        return apiClient.getItems(userId, {
            ParentId: library.Id,
            Recursive: true,
            IncludeItemTypes: MEDIA_TYPES,
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Limit: ROW_LIMIT,
            Fields: CARD_FIELDS,
            ImageTypeLimit: 1,
            EnableImageTypes: CARD_IMAGE_TYPES,
            EnableTotalRecordCount: false
        }).then(itemsResult => itemsResult.Items);
    });
}

// Rows shown directly under AI Smart Picks, in this order; empty rows are hidden
const FEATURE_ROWS = [
    {
        title: 'HeaderContinueWatching',
        fetchData: fetchContinueWatching,
        getItemsHtml: getEpisodeRowCardsHtml,
        monitor: 'videoplayback,markplayed'
    },
    {
        title: 'UpNextMovies',
        fetchData: apiClient => fetchAiPicks(apiClient, UP_NEXT_MOVIES_PREFS_KEY),
        getItemsHtml: getRowCardsHtml,
        monitor: 'markplayed'
    },
    {
        title: 'UpNextTvShows',
        fetchData: apiClient => fetchNextUpEpisodes(apiClient, false),
        getItemsHtml: getEpisodeRowCardsHtml,
        monitor: 'videoplayback,markplayed'
    },
    {
        title: 'UpNextAnime',
        fetchData: apiClient => fetchNextUpEpisodes(apiClient, true),
        getItemsHtml: getEpisodeRowCardsHtml,
        monitor: 'videoplayback,markplayed'
    },
    {
        title: 'RecentMovies',
        fetchData: apiClient => fetchRecentMedia(apiClient, ['movies'], false),
        getItemsHtml: getRowCardsHtml,
        monitor: 'markplayed'
    },
    {
        title: 'RecentTvShows',
        fetchData: apiClient => fetchRecentMedia(apiClient, ['tvshows'], false),
        getItemsHtml: getRowCardsHtml,
        monitor: 'markplayed'
    },
    {
        title: 'RecentAnime',
        fetchData: apiClient => fetchRecentMedia(apiClient, ['movies', 'tvshows'], true),
        getItemsHtml: getRowCardsHtml,
        monitor: 'markplayed'
    },
    {
        title: 'DiscoverMovies',
        fetchData: apiClient => fetchLibraryItems(apiClient, DISCOVER_MOVIES_LIBRARY),
        getItemsHtml: getRowCardsHtml,
        monitor: 'markplayed'
    },
    {
        title: 'DiscoverTvShows',
        fetchData: apiClient => fetchLibraryItems(apiClient, DISCOVER_SHOWS_LIBRARY),
        getItemsHtml: getRowCardsHtml,
        monitor: 'markplayed'
    }
];

function fetchGenreItems(apiClient, genreId) {
    return apiClient.getItems(apiClient.getCurrentUserId(), {
        GenreIds: genreId,
        IncludeItemTypes: MEDIA_TYPES,
        Recursive: true,
        SortBy: 'Random',
        Limit: ROW_LIMIT,
        Fields: CARD_FIELDS,
        ImageTypeLimit: 1,
        EnableImageTypes: CARD_IMAGE_TYPES,
        EnableTotalRecordCount: false
    }).then(result => (result.Items.length < MIN_ROW_ITEMS ? [] : result.Items));
}

function fetchBillboardItem(apiClient) {
    return apiClient.getItems(apiClient.getCurrentUserId(), {
        IncludeItemTypes: MEDIA_TYPES,
        Recursive: true,
        SortBy: 'Random',
        Filters: 'IsUnplayed',
        ImageTypes: 'Backdrop',
        // A few spares so the billboard never features a JellyBridge placeholder
        Limit: 10,
        Fields: 'Overview,Genres,OfficialRating,CommunityRating,ProductionYear,RunTimeTicks,ChildCount,Path',
        EnableImageTypes: 'Backdrop,Logo',
        EnableTotalRecordCount: false
    }).then(result => result.Items.find(item => !item.Path?.includes(PLACEHOLDER_PATH_MARKER)));
}

function getBillboardMeta(item) {
    const parts = [];

    if (item.ProductionYear) {
        parts.push(item.ProductionYear);
    }
    if (item.OfficialRating) {
        parts.push(`<span class="dmmBillboard-rating">${escapeHtml(item.OfficialRating)}</span>`);
    }
    if (item.Type === 'Series' && item.ChildCount) {
        parts.push(globalize.translate(item.ChildCount === 1 ? 'ValueOneSeason' : 'ValueSeasonCount', item.ChildCount));
    } else if (item.RunTimeTicks) {
        const minutes = Math.round(item.RunTimeTicks / 600000000);
        parts.push(`${Math.floor(minutes / 60)}h ${minutes % 60}m`);
    }
    if (item.CommunityRating) {
        parts.push(`<span class="material-icons dmmBillboard-star star" aria-hidden="true"></span>${item.CommunityRating.toFixed(1)}`);
    }
    if (item.Genres?.length) {
        parts.push(item.Genres.slice(0, 3).map(escapeHtml).join(' &bull; '));
    }

    return parts.map(p => `<span class="dmmBillboard-metaItem">${p}</span>`).join('');
}

export default function (view) {
    const billboard = view.querySelector('.dmmBillboard');
    const aiRow = view.querySelector('.dmmAiRow');
    const aiItemsContainer = aiRow.querySelector('.itemsContainer');
    const aiEmptyMessage = aiRow.querySelector('.dmmAiRow-empty');
    const featureRowsContainer = view.querySelector('.dmmFeatureRows');
    const genreRowsContainer = view.querySelector('.dmmGenreRows');

    featureRowsContainer.innerHTML = FEATURE_ROWS.map(row => `
        <div class="verticalSection dmmRow dmmFeatureRow hide">
            <h2 class="sectionTitle sectionTitle-cards padded-left dmmRow-title">${escapeHtml(globalize.translate(row.title))}</h2>
            <div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">
                <div is="emby-itemscontainer" class="itemsContainer scrollSlider focuscontainer-x" data-monitor="${row.monitor}"></div>
            </div>
        </div>`).join('');
    const featureItemsContainers = Array.from(featureRowsContainer.querySelectorAll('.itemsContainer'));
    featureItemsContainers.forEach((itemsContainer, index) => {
        itemsContainer.getItemsHtml = FEATURE_ROWS[index].getItemsHtml;
        itemsContainer.parentContainer = itemsContainer.closest('.dmmFeatureRow');
    });

    let billboardItem = null;
    let genreObserver = null;
    let isRendered = false;

    view.querySelector('.dmmAiRow-title').innerText = '🤖 AI Smart Picks';
    aiEmptyMessage.innerText = globalize.translate('AiSmartPicksEmpty');
    view.querySelector('.dmmBillboard-playText').innerText = globalize.translate('Play');
    view.querySelector('.dmmBillboard-infoText').innerText = globalize.translate('ButtonInfo');

    view.querySelector('.dmmBillboard-play').addEventListener('click', () => {
        if (billboardItem) {
            playbackManager.play({ items: [billboardItem] });
        }
    });

    view.querySelector('.dmmBillboard-info').addEventListener('click', () => {
        if (billboardItem) {
            appRouter.showItem(billboardItem);
        }
    });

    aiItemsContainer.getItemsHtml = getRowCardsHtml;
    aiItemsContainer.afterRefresh = result => {
        const isEmpty = !(result.Items || result).length;
        aiEmptyMessage.classList.toggle('hide', !isEmpty);
    };

    function renderBillboard(apiClient) {
        return fetchBillboardItem(apiClient).then(item => {
            billboardItem = item;
            if (!item) {
                billboard.classList.add('hide');
                return;
            }

            const backdrop = apiClient.getScaledImageUrl(item.Id, {
                type: 'Backdrop',
                maxWidth: 1920,
                tag: item.BackdropImageTags[0]
            });
            billboard.querySelector('.dmmBillboard-backdrop').style.backgroundImage = `url('${backdrop}')`;

            const logo = billboard.querySelector('.dmmBillboard-logo');
            const title = billboard.querySelector('.dmmBillboard-title');
            if (item.ImageTags?.Logo) {
                const logoUrl = apiClient.getScaledImageUrl(item.Id, {
                    type: 'Logo',
                    maxWidth: 800,
                    tag: item.ImageTags.Logo
                });
                logo.style.backgroundImage = `url('${logoUrl}')`;
                logo.setAttribute('aria-label', item.Name);
                logo.classList.remove('hide');
                title.classList.add('hide');
            } else {
                logo.classList.add('hide');
                title.innerText = item.Name;
                title.classList.remove('hide');
            }

            billboard.querySelector('.dmmBillboard-meta').innerHTML = getBillboardMeta(item);
            billboard.querySelector('.dmmBillboard-overview').innerText = item.Overview || '';
            billboard.classList.remove('hide');
        });
    }

    function loadGenreRow(entry) {
        if (!entry.isIntersecting) {
            return;
        }

        const row = entry.target;
        genreObserver.unobserve(row);
        row.querySelector('.itemsContainer').refreshItems();
    }

    function renderGenreRows(apiClient) {
        return apiClient.getGenres(apiClient.getCurrentUserId(), {
            IncludeItemTypes: MEDIA_TYPES,
            Recursive: true,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            EnableTotalRecordCount: false
        }).then(result => {
            genreRowsContainer.innerHTML = result.Items.map(genre => `
                <div class="verticalSection dmmRow dmmGenreRow" data-id="${escapeHtml(genre.Id)}">
                    <h2 class="sectionTitle sectionTitle-cards padded-left dmmRow-title">${escapeHtml(genre.Name)}</h2>
                    <div is="emby-scroller" class="padded-top-focusscale padded-bottom-focusscale" data-centerfocus="true">
                        <div is="emby-itemscontainer" class="itemsContainer scrollSlider focuscontainer-x" data-monitor="markplayed"></div>
                    </div>
                </div>`).join('');

            genreObserver = new IntersectionObserver(entries => entries.forEach(loadGenreRow), {
                rootMargin: '600px 0px'
            });

            for (const row of genreRowsContainer.querySelectorAll('.dmmGenreRow')) {
                const itemsContainer = row.querySelector('.itemsContainer');
                itemsContainer.fetchData = () => fetchGenreItems(apiClient, row.getAttribute('data-id'));
                itemsContainer.getItemsHtml = getRowCardsHtml;
                itemsContainer.parentContainer = row;
                genreObserver.observe(row);
            }
        });
    }

    function destroyGenreRows() {
        genreObserver?.disconnect();
        genreObserver = null;

        for (const itemsContainer of genreRowsContainer.querySelectorAll('.itemsContainer')) {
            itemsContainer.fetchData = null;
            itemsContainer.getItemsHtml = null;
            itemsContainer.parentContainer = null;
        }
        genreRowsContainer.innerHTML = '';
    }

    view.addEventListener('viewshow', () => {
        LibraryMenu.setTitle(null);
        LibraryMenu.setTransparentMenu(true);
        document.querySelector('.skinHeader').classList.add('noHomeButtonHeader');

        const apiClient = ServerConnections.currentApiClient();
        aiItemsContainer.fetchData = () => fetchAiPicks(apiClient);

        // The AI picks are refreshed on every visit so new script output shows up straight away
        const aiPromise = aiItemsContainer.resume({ refresh: true });

        // Watch progress changes between visits, so these rows are refreshed every time too
        const featurePromises = featureItemsContainers.map((itemsContainer, index) => {
            itemsContainer.fetchData = () => FEATURE_ROWS[index].fetchData(apiClient);
            return itemsContainer.resume({ refresh: true });
        });

        if (isRendered) {
            for (const itemsContainer of genreRowsContainer.querySelectorAll('.itemsContainer')) {
                itemsContainer.resume();
            }
            return;
        }

        isRendered = true;
        Promise.all([renderBillboard(apiClient), renderGenreRows(apiClient), aiPromise, ...featurePromises])
            .then(() => {
                imageLoader.lazyChildren(view);
                if (layoutManager.tv) {
                    focusManager.autoFocus(view);
                }
            })
            .catch(err => {
                console.error('[DarkMatterHome] failed to render home page', err);
            });
    });

    view.addEventListener('viewbeforehide', () => {
        LibraryMenu.setTransparentMenu(false);
        document.querySelector('.skinHeader').classList.remove('noHomeButtonHeader');

        for (const itemsContainer of view.querySelectorAll('.itemsContainer')) {
            itemsContainer.pause();
        }
    });

    view.addEventListener('viewdestroy', () => {
        destroyGenreRows();
        for (const itemsContainer of featureItemsContainers) {
            itemsContainer.fetchData = null;
            itemsContainer.getItemsHtml = null;
            itemsContainer.parentContainer = null;
        }
        aiItemsContainer.fetchData = null;
        aiItemsContainer.getItemsHtml = null;
        aiItemsContainer.afterRefresh = null;
        billboardItem = null;
    });
}
