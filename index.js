const STATE_KEY = 'privateRoutesIdentities';
const PRIVATE_STATE_KEY = 'privateRoutesState';
const API_KEY = 'privateRoutesIdentity';
const getContext = () => globalThis.SillyTavern?.getContext?.();

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function baseState(playerName) {
    return {
        version: 1,
        active: 'user',
        identities: {
            user: { id: 'user', displayName: playerName || '你', canonical: 'user', createdAt: Date.now() },
        },
        scores: {
            user: { affinity: 0, familiarity: 0, tension: 0, friction: { issue: '', repeats: 0 } },
        },
    };
}

function legacyPrivateState(context) {
    const current = context.chatMetadata?.[PRIVATE_STATE_KEY];
    const currentSource = current?.affinity && typeof current.affinity === 'object' ? current.affinity : current;
    if (Number.isFinite(Number(currentSource?.['$user']))) return current;
    for (let index = (context.chat?.length || 0) - 1; index >= 0; index--) {
        const turnState = context.chat[index]?.extra?.privateRoutesTurn?.state;
        const source = turnState?.affinity && typeof turnState.affinity === 'object' ? turnState.affinity : turnState;
        if (Number.isFinite(Number(source?.['$user']))) return turnState;
    }
    return null;
}

function stateFor(context) {
    const metadata = context.chatMetadata ??= {};
    const state = metadata[STATE_KEY] && typeof metadata[STATE_KEY] === 'object'
        ? metadata[STATE_KEY]
        : baseState(context.name1);
    state.version = 1;
    state.identities ??= {};
    state.scores ??= {};
    state.identities.user ??= { id: 'user', displayName: context.name1 || '你', canonical: 'user', createdAt: Date.now() };
    state.identities.user.displayName = context.name1 || state.identities.user.displayName || '你';
    state.identities.user.canonical = 'user';
    state.scores.user ??= { affinity: 0, familiarity: 0, tension: 0, friction: { issue: '', repeats: 0 } };
    if (!state.legacyMigrated || state.legacyMigrationVersion !== 2) {
        const privateState = legacyPrivateState(context);
        const source = privateState?.affinity && typeof privateState.affinity === 'object' ? privateState.affinity : privateState;
        const legacyId = Number.isFinite(Number(source?.['$user'])) ? '$user' : (Number.isFinite(Number(source?.user)) ? 'user' : null);
        if (legacyId) {
            const oldScore = Number(source[legacyId]);
            if (Number.isFinite(oldScore)) state.scores.user.affinity = oldScore;
            const oldFamiliarity = Number(privateState?.familiarity?.[legacyId]);
            const oldTension = Number(privateState?.tension?.[legacyId]);
            if (Number.isFinite(oldFamiliarity)) state.scores.user.familiarity = oldFamiliarity;
            if (Number.isFinite(oldTension)) state.scores.user.tension = oldTension;
            if (privateState?.friction?.[legacyId]) state.scores.user.friction = clone(privateState.friction[legacyId]);
        }
        state.legacyMigrated = true;
        state.legacyMigrationVersion = 2;
    }
    metadata[STATE_KEY] = state;
    return state;
}

function canonicalId(state, id) {
    let current = id;
    const seen = new Set();
    while (state.identities[current]?.canonical && state.identities[current].canonical !== current && !seen.has(current)) {
        seen.add(current);
        current = state.identities[current].canonical;
    }
    return current;
}

function scoreFor(state, id) {
    const score = state.scores[id] ?? {};
    return {
        affinity: Math.max(0, Math.min(100, Math.round(Number(score.affinity) || 0))),
        familiarity: Math.max(0, Math.min(100, Math.round(Number(score.familiarity) || 0))),
        tension: Math.max(0, Math.min(4, Math.round(Number(score.tension) || 0))),
        friction: score.friction && typeof score.friction === 'object'
            ? { issue: String(score.friction.issue || '').slice(0, 80), repeats: Math.max(0, Math.min(20, Math.round(Number(score.friction.repeats) || 0))) }
            : { issue: '', repeats: 0 },
    };
}

function ensureAlias(state, displayName) {
    const label = String(displayName || '小号').trim().slice(0, 24) || '小号';
    if (label === '小号') {
        const recentAlias = Object.values(state.identities).filter(identity => identity.id !== 'user' && canonicalId(state, identity.id) === identity.id).at(-1);
        if (recentAlias) return recentAlias.id;
    }
    const existing = Object.values(state.identities).find(identity => identity.displayName === label && canonicalId(state, identity.id) === identity.id);
    if (existing) return existing.id;
    const id = 'alias_' + (Object.keys(state.identities).filter(key => key.startsWith('alias_')).length + 1);
    state.identities[id] = { id, displayName: label, canonical: id, createdAt: Date.now() };
    state.scores[id] = { affinity: 0, familiarity: 0, tension: 0, friction: { issue: '', repeats: 0 } };
    return id;
}

function aliasNameFromText(text) {
    const named = text.match(/(?:小号|马甲|新账号|匿名账号)[\s，,：:、]*(?:叫|名为|名字是|名字叫|叫做)\s*[「『“"”]?([^」』“”"\s，。,\.。!?！？]{1,20})/u);
    if (named) return named[1];
    const before = text.match(/(?:创建|新建|注册|开了|弄了)\s*(?:一个|个)?\s*([^\s，。,\.。!?！？]{1,12})\s*(?:小号|马甲|账号)/u);
    return before?.[1] || '小号';
}

function applyNarrative(state, text) {
    const value = String(text || '');
    const reveal = value.match(/(?:小号|马甲|新账号)[^。！？\n]{0,12}(?:就是我|其实是我|原来是我|是我本人)/u)
        || value.match(/(?:告诉|坦白|揭露)[^。！？\n]{0,12}(?:小号|马甲|新账号)[^。！？\n]{0,8}(?:就是我|是我)/u);
    const namedReveal = Object.values(state.identities).find(identity => identity.id !== 'user' && canonicalId(state, identity.id) === identity.id && value.includes(identity.displayName) && /(?:就是我|其实是我|原来是我|是我本人)/u.test(value));
    if (reveal || namedReveal) {
        const aliases = Object.values(state.identities).filter(identity => identity.id !== 'user' && canonicalId(state, identity.id) === identity.id);
        const target = namedReveal || aliases.at(-1);
        if (target) {
            const source = scoreFor(state, target.id);
            const user = scoreFor(state, 'user');
            state.scores.user = {
                affinity: Math.max(user.affinity, source.affinity),
                familiarity: Math.max(user.familiarity, source.familiarity),
                tension: Math.max(user.tension, source.tension),
                friction: source.repeats > user.repeats ? source.friction : user.friction,
            };
            target.canonical = 'user';
            state.active = 'user';
        }
    }

    const create = /(?:创建|新建|注册|开了|弄了)\s*(?:一个|个)?\s*(?:小号|马甲|新账号|匿名账号)|(?:小号|马甲|新账号)[^。！？\n]{0,12}(?:联系|加|找|私聊)/u.test(value);
    if (create) {
        const id = ensureAlias(state, aliasNameFromText(value));
        state.active = id;
    }

    const switchAlias = value.match(/(?:用|切换到|换成|从)\s*(?:我的)?\s*(小号|马甲|新账号|匿名账号)/u);
    if (switchAlias) state.active = ensureAlias(state, switchAlias[1]);
    if (/(?:切回|换回|回到)\s*(?:本号|主号|原来的身份|本人)/u.test(value)) state.active = 'user';
}

function mergedIds(state, id) {
    const canonical = canonicalId(state, id);
    return Object.values(state.identities)
        .filter(identity => canonicalId(state, identity.id) === canonical)
        .map(identity => identity.id);
}

function privateStateOverride(context, state, route) {
    const current = context.chatMetadata?.[PRIVATE_STATE_KEY] && typeof context.chatMetadata[PRIVATE_STATE_KEY] === 'object'
        ? clone(context.chatMetadata[PRIVATE_STATE_KEY])
        : { version: 2, affinity: {}, familiarity: {}, tension: {}, friction: {}, obsession: null };
    const score = scoreFor(state, route.id);
    current.affinity ??= {};
    current.familiarity ??= {};
    current.tension ??= {};
    current.friction ??= {};
    current.affinity[route.id] = score.affinity;
    current.familiarity[route.id] = score.familiarity;
    current.tension[route.id] = score.tension;
    current.friction[route.id] = score.friction;
    return current;
}

function stage(score) {
    if (score <= 20) return '陌生';
    if (score <= 40) return '有点在意';
    if (score <= 60) return '有好感';
    if (score <= 80) return '喜欢';
    return '执念';
}

function bar(score) {
    const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function statusBlock({ state, playerRoute } = {}) {
    const context = getContext();
    if (!context) return '';
    const identityState = stateFor(context);
    const visible = Object.values(identityState.identities).filter(identity => canonicalId(identityState, identity.id) === identity.id);
    if (visible.length <= 1) return '';
    const currentId = playerRoute?.id || identityState.active;
    const rows = visible.map(identity => {
        const routeIds = mergedIds(identityState, identity.id);
        const currentScore = identity.id === currentId && state?.affinity?.[currentId] !== undefined
            ? Number(state.affinity[currentId]) || 0
            : Math.max(...routeIds.map(id => scoreFor(identityState, id).affinity), 0);
        return `- **${identity.displayName}**　\`${bar(currentScore)}\` ${currentScore}/100 · ${stage(currentScore)}`;
    });
    const activeName = identityState.identities[canonicalId(identityState, currentId)]?.displayName || '你';
    return ['### 用户身份关系', '', ...rows, '', `当前身份：**${activeName}**`].join('\n');
}

function prepareTurn({ context, input, playerName } = {}) {
    if (!context) return null;
    const state = stateFor(context);
    applyNarrative(state, input);
    const active = canonicalId(state, state.active || 'user');
    state.active = active;
    const identity = state.identities[active] || state.identities.user;
    const ids = mergedIds(state, active);
    const route = {
        id: active,
        historyIds: ids,
        stateIds: ids,
    };
    return {
        player: { name: identity.displayName || playerName || context.name1 || '你' },
        playerRoute: route,
        stateOverride: privateStateOverride(context, state, route),
    };
}

function commitTurn({ context, turn, playerRoute } = {}) {
    if (!context || !turn || !playerRoute) return;
    const state = stateFor(context);
    const id = canonicalId(state, playerRoute.id);
    const current = scoreFor(state, id);
    const affinity = Number(turn.state?.affinity?.[playerRoute.id]);
    const familiarity = Number(turn.state?.familiarity?.[playerRoute.id]);
    const tension = Number(turn.state?.tension?.[playerRoute.id]);
    const friction = turn.state?.friction?.[playerRoute.id];
    state.scores[id] = {
        affinity: Number.isFinite(affinity) ? affinity : current.affinity,
        familiarity: Number.isFinite(familiarity) ? familiarity : current.familiarity,
        tension: Number.isFinite(tension) ? tension : current.tension,
        friction: friction || current.friction,
    };
    context.chatMetadata[STATE_KEY] = state;
}

globalThis[API_KEY] = {
    prepareTurn,
    commitTurn,
    statusBlock,
    getState() {
        const context = getContext();
        return context ? clone(stateFor(context)) : null;
    },
};

function renderIdentityLabel() {
    const context = getContext();
    const root = document.querySelector('#private-routes-identities');
    if (!context || !root) return;
    const state = stateFor(context);
    const active = state.identities[canonicalId(state, state.active)] || state.identities.user;
    root.textContent = '当前身份：' + (active.displayName || context.name1 || '你');
    root.hidden = Object.keys(state.identities).length <= 1;
}

function initialize() {
    if (document.querySelector('#private-routes-identities')) return;
    const sendForm = document.querySelector('#send_form');
    if (!sendForm) return;
    const label = document.createElement('span');
    label.id = 'private-routes-identities';
    label.hidden = true;
    label.setAttribute('role', 'status');
    sendForm.before(label);
    const context = getContext();
    context?.eventSource?.on(context.eventTypes.CHAT_CHANGED, renderIdentityLabel);
    context?.eventSource?.on(context.eventTypes.GROUP_UPDATED, renderIdentityLabel);
    renderIdentityLabel();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
