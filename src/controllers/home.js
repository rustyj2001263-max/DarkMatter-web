import escapeHtml from 'escape-html';

import cardBuilder from '../components/cardbuilder/cardBuilder';
import focusManager from '../components/focusManager';
import imageLoader from '../components/images/imageLoader';
import layoutManager from '../components/layoutManager';
import { playbackManager } from '../components/playback/playbackmanager';
import { appRouter } from '../components/router/appRouter';
import globalize from '../lib/globalize';
import { ServerConnections } from '../lib/jellyfin-apiclient';
import LibraryMenu from '../scripts/libraryMenu';
import { getBackdropShape } from '../utils/card';

import '../elements/emby-button/emby-button';
import '../elements/emby-itemscontainer/emby-itemscontainer';
import '../elements/emby-scroller/emby-scroller';
import '../styles/dmmHome.scss';

// Per-user display preferences written by the AI Smart Picks script
// (/mnt/user/appdata/ai-smart-picks/smart_picks.py); must match PREFS_ID / PREFS_CLIENT / PREFS_KEY_IDS there
const AI_PICKS_PREFS_ID = 'dmmAiSmartPicks';
const AI_PICKS_PREFS_CLIENT = 'dmm';
const AI_PICKS_PREFS_KEY = 'aiSmartPicks';

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

function fetchAiPicks(apiClient) {
    const userId = apiClient.getCurrentUserId();

    return apiClient.getDisplayPreferences(AI_PICKS_PREFS_ID, userId, AI_PICKS_PREFS_CLIENT).then(prefs => {
        const ids = (prefs.CustomPrefs?.[AI_PICKS_PREFS_KEY] || '').split(',').filter(Boolean);
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
        console.error('[DarkMatterHome] failed to load AI Smart Picks', err);
        return [];
    });
}

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
        Limit: 1,
        Fields: 'Overview,Genres,OfficialRating,CommunityRating,ProductionYear,RunTimeTicks,ChildCount',
        EnableImageTypes: 'Backdrop,Logo',
        EnableTotalRecordCount: false
    }).then(result => result.Items[0]);
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
    const genreRowsContainer = view.querySelector('.dmmGenreRows');

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

        if (isRendered) {
            for (const itemsContainer of genreRowsContainer.querySelectorAll('.itemsContainer')) {
                itemsContainer.resume();
            }
            return;
        }

        isRendered = true;
        Promise.all([renderBillboard(apiClient), renderGenreRows(apiClient), aiPromise])
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
        aiItemsContainer.fetchData = null;
        aiItemsContainer.getItemsHtml = null;
        aiItemsContainer.afterRefresh = null;
        billboardItem = null;
    });
}
