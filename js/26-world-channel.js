// ========== 🌐 v3.6.50 世界頻道問答系統 ==========
//   ・玩家在世界頻道輸入列發問 → 隨機 1~3 名「線上玩家 NPC」回覆：可能認真回答、可能只是路過嘲笑。
//   ・答案盡量取自真實遊戲資料（DB.maps 出怪等級／DB.items 職業可用裝備／MASTERY_DATA 精通），不寫死攻略文字。
//   ・NPC 名字可點 → 嘲諷（依性向判定記仇並可能野外追殺）／感謝（好感回覆）。
//   ⚠️ NPC 名冊只存在記憶體（重整即換一批）；唯一會寫進存檔的是「嘲諷記仇」，比照 js/24 叫賣 NPC 的 _startWandererChase。

function _wcPick(list) { return (list && list.length) ? list[Math.floor(Math.random() * list.length)] : ''; }
function _wcEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _wcMakeName() {
    return (typeof pvpRandomName === 'function') ? pvpRandomName() : ('玩家' + Math.floor(Math.random() * 100000));
}

// ---- NPC 名冊（記憶體·每位有人格、職業與固定性向）----
const WC_PERSONAS = ['helpful', 'veteran', 'sarcastic', 'newbie', 'trader'];
let _wcNpcSeq = 0;
let _wcNpcs = Object.create(null);          // id -> { name, persona, cls, alignmentValue, thanked, taunted, blocked }
let _wcMenuOpenId = null;                    // 目前展開嘲諷/感謝選單的 NPC（同時只開一個）
let _wcMenuDocHandler = null;                 // 點擊選單外時關閉浮動選單
let _wcAskCooldownUntil = 0;                 // 連續發問節流（避免洗頻）
let _wcIdleTimer = null;                     // 每分鐘世界頻道自動閒聊
let _wcRecentIdleLines = [];                 // 避免短時間重複抽到相同閒聊
const WC_RECENT_CHAT_LIMIT = 60;

function _wcSpawnNpc() {
    let clsKeys = (typeof CLAN_CLASS_NAMES === 'object' && CLAN_CLASS_NAMES) ? Object.keys(CLAN_CLASS_NAMES) : ['knight'];
    let id = 'wc' + (++_wcNpcSeq);
    let alignmentValue = (typeof pvpRandomAlignment === 'function')
        ? pvpRandomAlignment()
        : Math.floor(-32767 + Math.random() * 65535);
    _wcNpcs[id] = {
        name: _wcMakeName(),
        persona: _wcPick(WC_PERSONAS),
        cls: _wcPick(clsKeys),
        alignmentValue: alignmentValue,
        thanked: false,
        taunted: false,
        blocked: false
    };
    // 名冊上限：只留最近 40 位（更早的名字點了也找不到人，屬於「已離線」）
    let ids = Object.keys(_wcNpcs);
    if (ids.length > 40) delete _wcNpcs[ids[0]];
    return id;
}
function _wcAlignmentValue(v) {
    return (typeof pvpClampAlignment === 'function')
        ? pvpClampAlignment(v)
        : Math.max(-32767, Math.min(32767, Math.round(Number(v) || 0)));
}
function _wcNameStyle(v) {
    v = _wcAlignmentValue(v);
    if (typeof pvpNameStyleByValue === 'function') return pvpNameStyleByValue(v);
    let color = (typeof pvpAlignmentColor === 'function')
        ? pvpAlignmentColor(v)
        : (v >= 1000 ? '#3b82f6' : (v <= -1000 ? '#ff4d4d' : '#ffffff'));
    return `color:${color}!important;text-shadow:1px 1px 0 #000,-1px 1px 0 #000,1px -1px 0 #000,-1px -1px 0 #000!important;`;
}
function _wcStaticNameHtml(name, alignmentValue) {
    if (typeof pvpNameHtml === 'function') return pvpNameHtml(name, _wcAlignmentValue(alignmentValue), 'wc-player-name');
    return `<span class="wc-player-name" style="${_wcNameStyle(alignmentValue)}">${_wcEsc(name)}</span>`;
}
function _wcNameHtml(id) {
    let n = _wcNpcs[id];
    if (!n) return '<span class="wc-name">???</span>';
    return `<span class="wc-player-name wc-name" data-wc-npc-id="${id}" style="${_wcNameStyle(n.alignmentValue)}" onclick="worldChannelNpcMenu('${id}', event)" title="點擊：嘲諷或感謝">${_wcEsc(n.name)}</span>`;
}

function _wcRemoveNpcMessages(id) {
    try {
        let el = document.getElementById('world-log');
        if (!el || !id) return;
        let clickNeedle = `worldChannelNpcMenu('${id}'`;
        let dataNeedle = `data-wc-npc-id="${id}"`;
        Array.from(el.children || []).forEach(row => {
            let html = row && row.innerHTML ? row.innerHTML : '';
            if (html.indexOf(clickNeedle) >= 0 || html.indexOf(dataNeedle) >= 0) row.remove();
        });
    } catch (e) {}
}
function _wcTauntChaseChance(npc) {
    let align = _wcAlignmentValue(npc && npc.alignmentValue);
    if (typeof pvpAlignmentKind === 'function') {
        let kind = pvpAlignmentKind(align);
        if (kind === 'evil') return 1;
        if (kind === 'justice') return 0.2;
        return 0.5;
    }
    if (align <= -1000) return 1;
    if (align >= 1000) return 0.2;
    return 0.5;
}
function _wcBlockedNotice() { logWorld('<span class="wc-sys">你已被對方封鎖。</span>'); }

// ================= 📚 依真實遊戲資料產生答案 =================
// ---- 地圖等級索引：掃 DB.maps 出怪池算「中位等級」，供練功地點推薦 ----
let _wcMapIndex = null;
function _wcBuildMapIndex() {
    if (_wcMapIndex) return _wcMapIndex;
    let nameOf = Object.create(null);
    try {
        if (typeof MAP_REGIONS !== 'undefined') MAP_REGIONS.forEach(r => (r.maps || []).forEach(m => { nameOf[m.v] = m.t; }));
    } catch (e) {}
    let out = [];
    try {
        for (let k in DB.maps) {
            if (/^town_/.test(k)) continue;                       // 安全區不是練功點
            let pool = DB.maps[k];
            if (!Array.isArray(pool) || !pool.length) continue;
            let lvs = pool.map(mk => (DB.mobs[mk] || {}).lv).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
            if (!lvs.length) continue;
            out.push({ key: k, name: nameOf[k] || k, lv: lvs[Math.floor(lvs.length / 2)], min: lvs[0], max: lvs[lvs.length - 1], listed: !!nameOf[k] });
        }
    } catch (e) {}
    _wcMapIndex = out;
    return out;
}
function _wcSpotsForLevel(lv) {
    // 只推薦地圖選單找得到的（隱藏圖不劇透）；⚠️ 傲慢之塔各樓層要逐層攀爬解鎖，不能當成「直接去掛」的練功點
    let idx = _wcBuildMapIndex().filter(m => m.listed && !/^pride_/.test(m.key));
    // 練功甜蜜點：怪物中位等級落在「玩家等級 −6 ~ +6」；不足就放寬到最接近者
    let near = idx.filter(m => m.lv >= lv - 6 && m.lv <= lv + 6);
    if (near.length < 2) near = idx.slice().sort((a, b) => Math.abs(a.lv - lv) - Math.abs(b.lv - lv)).slice(0, 4);
    near.sort((a, b) => Math.abs(a.lv - lv) - Math.abs(b.lv - lv));
    return near.slice(0, 3);
}
// ---- 職業可用裝備推薦：掃 DB.items 取該職業可裝備、非遺物/非傳說的高價位品 ----
function _wcGearFor(cls, slotWanted) {
    let out = [];
    try {
        for (let id in DB.items) {
            let d = DB.items[id];
            if (!d || !d.n) continue;
            if (d.type !== 'wpn' && d.type !== 'arm' && d.type !== 'acc') continue;
            if (d.relic || d.gachaWeight === 0 && !d.p) continue;   // 遺物走另一套問答；無價無權重的內部品跳過
            if (slotWanted === 'wpn' ? d.type !== 'wpn' : (slotWanted && d.slot !== slotWanted)) continue;
            if (typeof reqAllowsClass === 'function' && !reqAllowsClass(d, cls)) continue;
            out.push({ id: id, n: d.n, p: Number(d.p) || 0, legend: !!d.legend });
        }
    } catch (e) {}
    out.sort((a, b) => b.p - a.p);
    return out;
}
function _wcMasteryNames(cls) {
    try {
        let m = MASTERY_DATA[cls];
        if (!m) return [];
        let list = m.list || m;
        return Object.keys(list).map(k => (list[k] && list[k].n) || k).filter(Boolean);
    } catch (e) { return []; }
}
function _wcClsName(cls) { return (typeof CLAN_CLASS_NAMES === 'object' && CLAN_CLASS_NAMES[cls]) || cls || '你的職業'; }
function _wcMyLv() { return (typeof player !== 'undefined' && player && player.lv) ? player.lv : 1; }
function _wcMyCls() { return (typeof player !== 'undefined' && player && player.cls) ? player.cls : 'knight'; }
// 從問句抓等級數字（「50級去哪練」→50）；沒寫就用玩家目前等級
// ⚠️ v3.6.61 單位改為必要：原本 (級|等|lv)? 是選配 → 句中第一個數字都被當等級（「我+8了50級去哪練」抓到 8、「玩了3天」抓到 3）。
//    支援「50級／50等」與「lv50／Lv.50」兩種詞序。
function _wcLevelFromText(q, fallback) {
    let s = String(q);
    let m = s.match(/(\d{1,3})\s*(?:級|等)/) || s.match(/(?:lv|Lv|LV)\s*\.?\s*(\d{1,3})/);
    let v = m ? parseInt(m[1], 10) : NaN;
    return (Number.isFinite(v) && v >= 1 && v <= 120) ? v : fallback;
}
// 問句是否指名某職業（沒指名就用玩家自己的職業）
// ⚠️ 必須「長名優先」：「黑暗妖精」含有「妖精」、「龍騎士」含有「騎士」，照物件順序掃會被短名搶走。
function _wcClassFromText(q) {
    try {
        let keys = Object.keys(CLAN_CLASS_NAMES).sort((a, b) => (CLAN_CLASS_NAMES[b] || '').length - (CLAN_CLASS_NAMES[a] || '').length);
        for (let k of keys) if (q.indexOf(CLAN_CLASS_NAMES[k]) >= 0) return k;
    } catch (e) {}
    return null;
}

// ---- 攻略索引：物品、怪物、地圖、掉落與商店都直接讀現行資料，避免答案跟改版脫節 ----
let _wcKnowledge = null;
const WC_ITEM_ALIASES = [
    { words: ['祝武', '祝福武卷', '祝福武器卷'], name: '祝福的 對武器施法的卷軸' },
    { words: ['祝防', '祝福防卷', '祝福防具卷'], name: '祝福的 對盔甲施法的卷軸' },
    { words: ['白武', '武卷', '武器卷'], name: '對武器施法的卷軸' },
    { words: ['白防', '防卷', '防具卷'], name: '對盔甲施法的卷軸' },
    { words: ['魂體', '魂體轉換'], name: '精靈水晶(魂體轉換)' },
    { words: ['究光', '究極光裂'], name: '魔法書(究極光裂術)' },
    { words: ['生祝', '生命祝福'], name: '精靈水晶(生命的祝福)' },
    { words: ['雙破', '雙重破壞'], name: '黑暗精靈水晶(雙重破壞)' },
    { words: ['屬火', '屬性之火'], name: '精靈水晶(屬性之火)' },
    { words: ['神聖疾走'], name: '魔法書(神聖疾走)' },
    { words: ['風之疾走'], name: '精靈水晶(風之疾走)' },
    { words: ['火牢'], name: '魔法書(火牢)' },
    { words: ['冰雪颶風', '冰雪'], name: '魔法書(冰雪颶風)' },
    { words: ['餅乾'], name: '精靈餅乾' },
    { words: ['強力加速術'], name: '魔法書(強力加速術)' },   // ⚠️ 放在「加速術」前：先長後短
    { words: ['加速術'], name: '魔法書(加速術)' },
    { words: ['解毒'], name: '魔法書(解毒術)' }
];
function _wcBuildKnowledge() {
    if (_wcKnowledge) return _wcKnowledge;
    let mapNames = Object.create(null), mobMaps = Object.create(null), mapMobs = Object.create(null);
    let itemDrops = Object.create(null), mobDrops = Object.create(null), shopItems = new Set();
    try {
        if (typeof MAP_REGIONS !== 'undefined') MAP_REGIONS.forEach(r => (r.maps || []).forEach(m => { mapNames[m.v] = m.t; }));
        for (let mapKey in DB.maps) {
            let mapName = mapNames[mapKey];
            if (!mapName || !Array.isArray(DB.maps[mapKey])) continue;
            let seen = new Set();
            DB.maps[mapKey].forEach(mobId => {
                let mob = DB.mobs[mobId];
                if (!mob || !mob.n || seen.has(mob.n)) return;
                seen.add(mob.n);
                (mobMaps[mob.n] = mobMaps[mob.n] || []).push({ key: mapKey, name: mapName });
            });
            mapMobs[mapName] = Array.from(seen);
        }
    } catch (e) {}
    function addDropTable(table) {
        if (!table) return;
        Object.keys(table).forEach(mobName => (table[mobName] || []).forEach(entry => {
            let itemId = Array.isArray(entry) ? entry[0] : entry;
            let rate = Array.isArray(entry) ? Number(entry[1]) : NaN;
            if (!itemId || !DB.items[itemId]) return;
            let row = { itemId: itemId, mob: mobName, rate: Number.isFinite(rate) ? rate : null, maps: mobMaps[mobName] || [] };
            (itemDrops[itemId] = itemDrops[itemId] || []).push(row);
            (mobDrops[mobName] = mobDrops[mobName] || []).push(row);
        }));
    }
    try { if (typeof MOB_DROPS !== 'undefined') addDropTable(MOB_DROPS); } catch (e) {}
    try { if (typeof DARK_WEAPON_DROPS !== 'undefined') addDropTable(DARK_WEAPON_DROPS); } catch (e) {}
    try { if (typeof DRAGON_DROPS !== 'undefined') addDropTable(DRAGON_DROPS); } catch (e) {}
    try { if (typeof WARRIOR_DROPS !== 'undefined') addDropTable(WARRIOR_DROPS); } catch (e) {}
    try { if (typeof MEM_DROPS !== 'undefined') addDropTable(MEM_DROPS); } catch (e) {}
    try { if (typeof DARK_CRYSTAL_DROPS !== 'undefined') addDropTable(DARK_CRYSTAL_DROPS); } catch (e) {}
    try {
        if (typeof SHOP_LISTS !== 'undefined') Object.keys(SHOP_LISTS).forEach(k => (SHOP_LISTS[k] || []).forEach(id => shopItems.add(id)));
    } catch (e) {}
    let itemNames = [];
    try {
        Object.keys(DB.items).forEach(id => {
            let d = DB.items[id];
            if (d && d.n && d.n.length >= 2) itemNames.push({ id: id, name: d.n });
        });
    } catch (e) {}
    itemNames.sort((a, b) => b.name.length - a.name.length);
    let mobNames = Object.keys(mobMaps).concat(Object.keys(mobDrops).filter(n => !mobMaps[n]));
    mobNames = Array.from(new Set(mobNames)).filter(n => n.length >= 2).sort((a, b) => b.length - a.length);
    let mapEntries = Object.keys(mapMobs).map(name => ({ name: name, mobs: mapMobs[name] })).sort((a, b) => b.name.length - a.name.length);
    // 🛠️ v3.6.61 製作配方索引：成品 id → 製作 NPC／所在村莊／材料清單（材料講名稱與數量·不講機率）
    let craftBy = Object.create(null);
    try {
        let npcHome = Object.create(null);   // npc id → { n: NPC 名, town: 村莊名 }（⚠️ 安全區資料在 DB.towns，不在 DB.maps）
        for (let mk in DB.towns) { let tw = DB.towns[mk]; if (tw && Array.isArray(tw.npcs)) tw.npcs.forEach(np => { if (np && np.id && !npcHome[np.id]) npcHome[np.id] = { n: np.n, town: tw.n }; }); }
        if (typeof CRAFT_RECIPES === 'object' && CRAFT_RECIPES) for (let nk in CRAFT_RECIPES) (CRAFT_RECIPES[nk] || []).forEach(rc => {
            if (!rc || !rc.result || craftBy[rc.result]) return;
            let home = npcHome[nk];
            craftBy[rc.result] = {
                npc: home ? home.n : '製作 NPC', town: home ? home.town : '',
                mats: (rc.req || []).map(p => p.id === 'gold' ? `金幣×${(p.cnt || 0).toLocaleString()}` : `${(DB.items[p.id] || {}).n || p.id}×${p.cnt || 1}`)
            };
        });
    } catch (e) {}
    _wcKnowledge = { itemNames: itemNames, mobNames: mobNames, mapEntries: mapEntries, itemDrops: itemDrops, mobDrops: mobDrops, shopItems: shopItems, craftBy: craftBy };
    return _wcKnowledge;
}
function _wcCompactItemText(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[\s()（）【】「」『』·．。！？!?、，,：:；;／/\\_\-+]/g, '');
}
function _wcItemFuzzyNeedle(q) {
    let s = String(q == null ? '' : q);
    s = s
        .replace(/有人知道|請問一下|請問|想問一下|想問|問一下|麻煩問一下|麻煩|幫我查一下|幫我查|幫我/g, '')
        .replace(/[哪那]裡會掉|[哪那]邊會掉|在[哪那]裡掉|在[哪那]邊掉/g, '')
        .replace(/[哪那]裡打|[哪那]邊打|在[哪那]打|[哪那]打|打[哪那]/g, '')
        .replace(/[哪那]裡出|[哪那]邊出|在[哪那]出|[哪那]裡學|去[哪那]學|[哪那]學/g, '')
        .replace(/[哪那]裡買|去[哪那]買|[哪那]買|[哪那]裡拿|去[哪那]拿|[哪那]拿/g, '')
        .replace(/[哪那]裡找|去[哪那]找|[哪那]裡做|[哪那]裡弄|去[哪那]弄|去[哪那]刷/g, '')
        .replace(/誰掉|[哪那]掉|會掉|掉落|出處|來源|刷什麼|怎麼拿|怎麼取得|怎取得|如何取得|取得/g, '')
        .replace(/怎麼學|怎麼買|怎麼做|怎麼獲得|如何獲得|如何入手|入手|怎麼弄/g, '')
        .replace(/這個|這件|這本|這把|那個|那件|那本|那把|物品名稱|物品/g, '')
        .replace(/一下|嗎|呢|啊|阿|？|\?/g, '');
    return _wcCompactItemText(s);
}
function _wcLongestSharedItemText(a, b) {
    if (!a || !b) return 0;
    let shorter = a.length <= b.length ? a : b;
    let longer = a.length <= b.length ? b : a;
    for (let len = shorter.length; len >= 2; len--) {
        for (let start = 0; start + len <= shorter.length; start++) {
            if (longer.indexOf(shorter.slice(start, start + len)) >= 0) return len;
        }
    }
    return 0;
}
function _wcFindItem(q, allowFuzzy) {
    let k = _wcBuildKnowledge();
    let hit = k.itemNames.find(x => q.indexOf(x.name) >= 0);
    if (hit) return hit;
    for (let a of WC_ITEM_ALIASES) {
        if (!a.words.some(w => q.indexOf(w) >= 0)) continue;
        let aliasHit = k.itemNames.find(x => x.name === a.name);
        if (aliasHit) return aliasHit;
    }
    if (!allowFuzzy) return null;
    let needle = _wcItemFuzzyNeedle(q);
    if (needle.length < 2 || ['物品', '裝備', '武器', '防具', '飾品', '道具', '材料', '魔法', '技能', '技能書', '魔法書', '水晶'].indexOf(needle) >= 0) return null;
    let best = null;
    k.itemNames.forEach(x => {
        let name = _wcCompactItemText(x.name);
        let shared = _wcLongestSharedItemText(needle, name);
        if (shared < 2) return;
        let containsWholeNeedle = name.indexOf(needle) >= 0 ? 1 : 0;
        if (!best
            || shared > best.shared
            || (shared === best.shared && containsWholeNeedle > best.containsWholeNeedle)
            || (shared === best.shared && containsWholeNeedle === best.containsWholeNeedle && name.length < best.nameLength)) {
            best = { item: x, shared: shared, containsWholeNeedle: containsWholeNeedle, nameLength: name.length };
        }
    });
    if (best) return best.item;
    return null;
}
function _wcFindMob(q) {
    let k = _wcBuildKnowledge();
    let name = k.mobNames.find(n => q.indexOf(n) >= 0);
    return name || null;
}
function _wcFindMap(q) {
    return _wcBuildKnowledge().mapEntries.find(m => q.indexOf(m.name) >= 0) || null;
}
function _wcDropPlace(row) {
    let maps = (row.maps || []).map(m => m.name).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2);
    let where = maps.length ? `（${maps.join('／')}）` : '';
    return `${row.mob}${where}`;
}
function _wcTrialOwnerText(itemId) {
    try {
        let owner = TRIAL_ITEM_CLASS[itemId];
        if (!owner) return '';
        let list = Array.isArray(owner) ? owner : [owner];
        return list.map(_wcClsName).join('／');
    } catch (e) { return ''; }
}
function _wcTrial50Source(itemId) {
    try {
        for (let cls in TRIAL_50_CFG) {
            let cfg = TRIAL_50_CFG[cls];
            let stageIndex = (cfg.stages || []).findIndex(s => s.id === itemId);
            if (stageIndex >= 0) {
                let stage = cfg.stages[stageIndex];
                return { cls: cls, npc: cfg.npc, stage: stageIndex + 1, name: stage.nm, count: stage.cnt, hint: stage.hint };
            }
        }
    } catch (e) {}
    return null;
}
function _wcItemSourceAnswers(itemId) {
    let d = DB.items[itemId];
    if (!d) return WC_UNKNOWN_LINES;
    let k = _wcBuildKnowledge();
    let rows = (k.itemDrops[itemId] || []).slice().sort((a, b) => (b.rate || 0) - (a.rate || 0));
    let owner = _wcTrialOwnerText(itemId);
    let trial50 = _wcTrial50Source(itemId);
    if (trial50 && !rows.length) return [
        `${d.n}是${_wcClsName(trial50.cls)} 50級試煉第${trial50.stage}階段材料。先找${trial50.npc}接取並推進到該階段，取得方式是${trial50.hint}；階段不對時不會掉。`,
        `要拿${d.n}，先把${_wcClsName(trial50.cls)} 50級試煉做到第${trial50.stage}階段，再去${trial50.hint}。需求是${trial50.count}個，沒接或還沒推到這段都算白打。`
    ];
    let craft = k.craftBy[itemId] || null;   // 🛠️ v3.6.61 製作品：講 NPC／村莊／材料與數量（不講機率）
    let craftNote = craft ? `也可以${craft.town ? `去${craft.town}` : ''}找${craft.npc}製作。` : '';
    if (rows.length) {
        let places = rows.slice(0, 4).map(r => _wcDropPlace(r)).join('、');
        if (owner) return [
            `${d.n}是${owner}試煉道具，來源是 ${places}；要先接取並進行到對應試煉階段才會掉。`,
            `${d.n}會由 ${places} 掉落，但只有${owner}進行對應試煉階段時才能取得。`
        ];
        return [
            `${d.n}會由 ${places} 掉落。${craftNote}`,
            `要刷${d.n}就找 ${places}。${craftNote}`
        ];
    }
    if (craft) return [
        `${d.n}是製作品：${craft.town ? `去${craft.town}` : ''}找${craft.npc}，材料是 ${craft.mats.join('、')}。`,
        `${d.n}要找${craft.town ? craft.town + '的' : ''}${craft.npc}做，備齊 ${craft.mats.join('、')} 就能做出來。`
    ];
    if (k.shopItems.has(itemId)) return [
        `${d.n}在村莊商店販售，不用找怪刷；看各村商人清單就能找到。`,
        `這個不是靠專屬怪物掉落，去翻村莊商店比較快，別跟野外怪耗到天亮。`
    ];
    if (d.gachaWeight > 0) return [
        `${d.n}目前在怪物專屬掉落表查不到直接來源，但有進潘朵拉黑市池；也可能屬於製作、任務或兌換品。`,
        `查不到哪隻怪會直接掉${d.n}。先看製作與任務 NPC，潘朵拉黑市也有機會出現。`
    ];
    return [
        `${d.n}目前不在怪物專屬掉落表，也不在一般村莊商店清單；多半要走製作、任務或特殊兌換。`,
        `這件不是叫你隨便找一張圖硬刷的，掉落表沒有直接來源，去查物品說明與製作 NPC。`
    ];
}
// 🐾 v3.6.63 寵物取得管道索引：型態名 → 來源說明。**三個來源全部從既有表反查**（遺物蛋 RELIC_EGG_PETS／誘捕 PET_LURES／進化 PET_BOOK.evo），
//    所以日後新增寵物、新增蛋、改誘食都不必回頭改這裡——這也是「新資料自動進 NPC 回答庫」的作法。
let _wcPetSourceIdx = null;
function _wcBuildPetSources() {
    if (_wcPetSourceIdx) return _wcPetSourceIdx;
    let idx = Object.create(null), k = _wcBuildKnowledge();
    let push = (pet, line) => { if (pet && line) (idx[pet] = idx[pet] || []).push(line); };
    // ① 遺物蛋：eff → 蛋物品 → 蛋的掉落怪（講怪名與地點·不講機率）
    try {
        for (let eff in RELIC_EGG_PETS) {
            let eggId = Object.keys(DB.items).find(id => DB.items[id] && DB.items[id].eff === eff);
            if (!eggId) continue;
            let rows = (k.itemDrops[eggId] || []).slice(0, 3).map(r => _wcDropPlace(r));
            push(RELIC_EGG_PETS[eff].pet, `使用「${DB.items[eggId].n}」孵化${rows.length ? `，蛋要打 ${rows.join('、')}` : ''}；潘朵拉黑市搜「未知遺物」也可能開到`);
        }
    } catch (e) {}
    // ② 誘捕：PET_LURES[key].mobs = { 怪名: 型態名 }
    try {
        for (let key in PET_LURES) {
            let lure = PET_LURES[key];
            for (let mobName in (lure.mobs || {})) push(lure.mobs[mobName], `帶「${lure.n}」用掉取得誘捕狀態，再擊殺 ${mobName}`);
        }
    } catch (e) {}
    // ③ 進化：PET_BOOK[基礎型態].evo = 進化後型態名（Lv30＋對應進化果實）
    try {
        for (let base in PET_BOOK) { let evo = PET_BOOK[base] && PET_BOOK[base].evo; if (evo) push(evo, `由 ${base} 練到 Lv30 後用進化果實進化`); }
    } catch (e) {}
    // ④ 兩條特例管道（無法從資料表推導·硬寫）：頑皮幼龍蛋隨機孵 淘氣龍/頑皮龍；勝利果實把任一「一般型態」直接進化成 黃金龍
    try {
        let eggRows = (k.itemDrops['item_dragon_egg'] || []).slice(0, 3).map(r => _wcDropPlace(r));
        ['淘氣龍', '頑皮龍'].forEach(p => push(p, `使用「頑皮幼龍蛋」隨機孵化（兩種各半）${eggRows.length ? `，蛋打 ${eggRows.join('、')}` : ''}`));
    } catch (e) {}
    push('黃金龍', '任一「一般型態」寵物 Lv30 後改用勝利果實進化（與高等型態二選一）');
    _wcPetSourceIdx = idx;
    return idx;
}
function _wcFindPet(q) {   // 長名優先（「高等杜賓狗」含「杜賓狗」）
    try {
        let names = Object.keys(PET_BOOK).sort((a, b) => b.length - a.length);
        return names.find(n => q.indexOf(n) >= 0) || null;
    } catch (e) { return null; }
}
function _wcPetSourceAnswers(petName) {
    let src = _wcBuildPetSources()[petName] || [];
    let def = null; try { def = PET_BOOK[petName]; } catch (e) {}
    let noEvo = def && def.evo === null && def.kind === 'spec' ? '這隻不能進化，拿到就是最終型態。' : '';
    if (!src.length) return [`${petName}我查不到固定的取得管道，可能要靠特殊活動或改版新增的來源。`];
    return [
        `${petName}的取得方式：${src.join('；或')}。${noEvo}`,
        `想要${petName}就走這條：${src[0]}。${noEvo}寵物保管有上限，先清一清再去弄。`
    ];
}
function _wcShuffle(arr) {   // Fisher-Yates（回新陣列·不動來源）
    let a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { let j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}
function _wcMobDropAnswers(mobName) {
    let rows = (_wcBuildKnowledge().mobDrops[mobName] || []).slice();
    if (!rows.length) return [`${mobName}沒有登記怪物專屬掉落；一般金幣、卡片或區域額外掉落不算在這張表裡。`];
    let seen = new Set(), pool = [], relics = [];
    // 🏺 v3.6.63 遺物獨立成列：遺物掉率極低，混在一般掉落裡排序會沉到末段被截掉→玩家永遠看不到新遺物。
    rows.forEach(r => {
        if (seen.has(r.itemId)) return;
        let d = DB.items[r.itemId];
        if (!d) return;
        seen.add(r.itemId);
        if (d.relic) { relics.push(d.n); return; }
        let trial = _wcTrialOwnerText(r.itemId);
        pool.push(`${d.n}${trial ? '（對應試煉進行中才會掉）' : ''}`);
    });
    // 🎲 v3.6.64 用戶要求：掉落物**隨機抽幾樣**就好，不必整串報完（同一隻怪每次問到的組合不同，也比較像玩家隨口回答）。
    let parts = _wcShuffle(pool).slice(0, 3 + Math.floor(Math.random() * 2));   // 3~4 樣
    let more = pool.length > parts.length ? '之類的，還有其他雜物' : '';
    let relicTxt = relics.length ? `另外牠身上有遺物：${_wcPick(relics)}，但那是要靠運氣的東西。` : '';
    if (!parts.length) return [`${mobName}的專屬掉落只有遺物：${_wcPick(relics)}。`];
    return [
        `${mobName}會掉 ${parts.join('、')}${more}。${relicTxt}`,
        `打${mobName}可以拿到 ${parts.join('、')}${more}。${relicTxt}`,
        `${mobName}我印象中有 ${parts.join('、')}${more}，詳細的自己開統計的掉落物頁看。${relicTxt}`
    ];
}
function _wcMapMobAnswers(map) {
    let mobs = (map && map.mobs) || [];
    if (!mobs.length) return [`${map ? map.name : '這張圖'}目前查不到固定怪物池。`];
    let shown = mobs.slice(0, 12);
    return [
        `${map.name}會出現 ${shown.join('、')}${mobs.length > shown.length ? ` 等 ${mobs.length} 種怪物` : ''}。`,
        `你問${map.name}？怪物池有 ${shown.join('、')}${mobs.length > shown.length ? '，其他可以在統計掉落頁繼續看' : ''}。`
    ];
}
function _wcItemInfoAnswers(itemId) {
    let d = DB.items[itemId];
    if (!d) return WC_UNKNOWN_LINES;
    let desc = String(d.d || '').replace(/<[^>]*>/g, '').trim();
    let req = d.req && d.req !== 'all' ? String(d.req).split(',').map(_wcClsName).join('／') : '全職業';
    if (desc) return [`${d.n}：${desc} 可用職業是${req}。`, `${d.n}的物品說明寫的是：${desc}`];
    return [`${d.n}可用職業是${req}；這件沒有額外用途文字，能力以物品資訊面板顯示為準。`];
}
function _wcTrialLevelFromText(q) {
    let m = String(q).match(/(?:^|[^\d])(15|30|45|50)\s*(?:級|等|lv|LV)?/);
    return m ? Number(m[1]) : null;
}
function _wcTrialReqText(itemId, count) {
    let d = DB.items[itemId], name = d ? d.n : itemId;
    let rows = (_wcBuildKnowledge().itemDrops[itemId] || []).slice(0, 3);
    let source = rows.length ? `：打 ${rows.map(r => _wcDropPlace(r)).join('、')}` : '';
    return `${name}×${count}${source}`;
}
function _wcTrialAnswers(q) {
    let cls = _wcClassFromText(q) || _wcMyCls();
    let lv = _wcTrialLevelFromText(q);
    let all = [];
    try { all = Object.keys(TRIAL_Q).map(k => Object.assign({ key: k }, TRIAL_Q[k])); } catch (e) {}
    let named = all.filter(c => q.indexOf(c.npc) >= 0);
    let trial = all.find(c => c.cls === cls && (!lv || c.lv === lv) && (!named.length || q.indexOf(c.npc) >= 0));
    if (!trial && named.length) trial = named.find(c => c.cls === cls) || named[0];
    if (trial) {
        let reqs = trial.reqs.map(p => _wcTrialReqText(p[0], p[1])).join('；');
        let rewards = trial.rewards.map(id => (DB.items[id] || {}).n || id).join('＋');
        return [
            `${_wcClsName(trial.cls)} ${trial.lv} 級試煉找${trial.npc}接取。需求是 ${reqs}；接取後指定試煉品必掉，備齊回去可一次領 ${rewards}。`,
            `先去找${trial.npc}接${trial.lv}級試煉，沒接任務打多久都不會出。接著收集 ${reqs}，最後獎勵是 ${rewards}。`
        ];
    }
    if (lv === 50) {
        let cfg = null;
        try { cfg = TRIAL_50_CFG[cls]; } catch (e) {}
        if (!cfg) return [`${_wcClsName(cls)}目前查不到 50 級試煉設定。`];
        let stages = cfg.stages.map(s => `${s.nm}×${s.cnt}（${s.hint}）`).join('；');
        let finalCount = cfg.exMatCnt || 1;
        let rewards = cfg.rewards.map(r => r.nm).join('＋');
        return [
            `${_wcClsName(cls)} 50 級試煉找${cfg.npc}。先完成 ${stages}；之後進魔族神殿收集${cfg.exMatNm}×${finalCount}，一次領取 ${rewards}。`,
            `50級先找${cfg.npc}接：${stages}。前段交完才開最終階段，最後要${cfg.exMatNm}×${finalCount}，獎勵是 ${rewards}。`
        ];
    }
    let mine = all.filter(c => c.cls === cls).sort((a, b) => a.lv - b.lv);
    let cfg50 = null;
    try { cfg50 = TRIAL_50_CFG[cls]; } catch (e) {}
    let route = mine.map(c => `${c.lv}級找${c.npc}`).join('、');
    if (cfg50) route += `${route ? '、' : ''}50級找${cfg50.npc}`;
    return [
        `${_wcClsName(cls)}試煉路線是：${route}。告訴我等級或試煉道具名稱，我才能講精確打法。`,
        `試煉一定要先接取。${_wcClsName(cls)}依序是 ${route}，你問清楚幾級，頻道才不會集體通靈。`
    ];
}
// 🗺️ v3.6.61 「怎麼去」路線表：特殊入口優先（搭船／隱藏圖／消耗品入場），其餘比對 MAP_REGIONS 報下拉選單位置
const WC_GOTO_SPECIAL = [
    { words: ['遺忘之島'], lines: [
        '遺忘之島要去海音港口找老船長依斯巴搭船，付了船費先經過海上航段才會靠岸。',
        '海音找依斯巴，跟他說要出海就對了；中途會先打一段遺忘之島途中，撐過去就到了。'
    ] },
    { words: ['時空裂痕'], lines: [
        '時空裂痕從地圖選單進，但要先有 1 顆龜裂之核；核去希培利亞找巴特爾用時空裂痕碎片做。',
        '先收集時空裂痕碎片找巴特爾做龜裂之核，有核才進得了裂痕；進去後就不能傳送了，自己斟酌。'
    ] },
    { words: ['傲慢之塔', '傲塔'], lines: [
        '傲慢之塔從入口逐層往上爬，打倒十樓的潔尼斯女王後，低樓層才能直接挑戰；更高樓要靠攀登或對應支配符。'
    ] },
    { words: ['黑暗妖精聖地', '妖精聖地', '長老之室', '長老會議廳', '格蘭肯', '提卡爾', '底比斯', '隱藏地圖', '隱藏區域'], lines: [
        '那是隱藏狩獵區，不會出現在地圖選單；要在對應地區的野外施放傳送術探索，才有機會被送進去。',
        '隱藏圖靠傳送術：在相關地區野外掛著傳送術亂飛，飛到就進去了。地圖選單找不到是正常的。'
    ] }
];
function _wcGotoAnswers(q) {
    for (let s of WC_GOTO_SPECIAL) if (s.words.some(w => q.indexOf(w) >= 0)) return s.lines;
    try {
        for (let r of MAP_REGIONS) for (let m of (r.maps || [])) if (m.t && q.indexOf(m.t) >= 0) return [
            `${m.t}直接開換地圖的下拉選單，在「${r.label}」分類底下就能選。`,
            `打開地圖下拉找「${r.label}」地區，${m.t}就在裡面，點了就過去。`
        ];
        // 地名去掉樓層/括號後綴再比一次：「象牙塔怎麼去」要對得到「象牙塔（1~3樓）」
        for (let r of MAP_REGIONS) for (let m of (r.maps || [])) {
            let base = String(m.t || '').replace(/（[^）]*）|\([^)]*\)/g, '').replace(/\d+\s*樓$/, '').replace(/[0-9~]+$/, '').trim();
            if (base.length >= 2 && q.indexOf(base) >= 0) return [
                `${base}在換地圖下拉的「${r.label}」分類裡，直接選就能過去。`,
                `開地圖選單找「${r.label}」地區，${base}相關的圖都在那一排。`
            ];
        }
        for (let r of MAP_REGIONS) if (r.label && q.indexOf(r.label) >= 0) return [
            `${r.label}一帶的地圖都在換地圖下拉的「${r.label}」分類裡，直接選就能過去。`
        ];
    } catch (e) {}
    return null;
}
function _wcDynamicTopic(q) {
    // ⚠️ v3.6.61 「任務怎麼」會把攻城/血盟類任務也拉進職業試煉 → 這些詞出現時不走試煉
    let trialAsked = /試煉|任務怎麼|任務怎樣|試煉品|試煉道具/.test(q) && !/攻城|血盟|城堡|收購/.test(q);
    if (trialAsked) return { key: 'trial-live', gen: function () { return _wcTrialAnswers(q); } };
    // 🗺️ v3.6.61 「怎麼去」類問題：比對地名回報路線（巴哈實際問法：黑暗妖精聖地怎麼去／象牙塔怎麼去）
    if (/怎麼去|怎麼走|怎麼過去|怎麼到|怎麼進|入口在哪|怎樣去/.test(q)) {
        let go = _wcGotoAnswers(q);
        if (go) return { key: 'goto', gen: function () { return go; } };
    }
    // ⚠️ v3.6.61 補「學／買／做／弄／獲得」動詞：技能書「哪裡學」、藥水「哪裡買」原本全落空只會被嘲笑
    let sourceAsked = /[哪那]裡打|[哪那]邊打|在[哪那]打|[哪那]打|打[哪那]|誰掉|[哪那]掉|會掉|掉落|出處|來源|怎麼拿|怎麼取得|怎取得|如何取得|[哪那]裡出|刷什麼|去[哪那]刷|取得|[哪那]裡學|去[哪那]學|[哪那]學|怎麼學|[哪那]裡買|去[哪那]買|[哪那]買|怎麼買|[哪那]裡拿|去[哪那]拿|[哪那]拿|[哪那]裡找|去[哪那]找|怎麼做|[哪那]裡做|怎麼獲得|如何獲得|如何入手|入手|怎麼弄|[哪那]裡弄|去[哪那]弄/.test(q);
    let item = _wcFindItem(q, sourceAsked);
    // ⚠️ 「龍之鑽石」不是背包物品（會被物品「鑽石」substring 誤中）→ 交給 blackmarket 主題
    if (item && sourceAsked && !/龍之鑽石|龍鑽/.test(q)) return { key: 'item-source', gen: function () { return _wcItemSourceAnswers(item.id); } };
    // 🐾 v3.6.63 寵物取得：問句點名某隻寵物 → 講該隻的實際管道（蛋／誘捕／進化），別再回制式寵物說明。
    //    ⚠️ 必須排在 _wcFindMob 之前：多數寵物名同時是怪物名（誘捕來源），否則會被 mob-drop 搶走。
    let petName = _wcFindPet(q);
    if (petName && /怎麼拿|怎麼抓|哪裡抓|去哪抓|哪裡拿|去哪拿|怎麼獲得|如何獲得|怎麼取得|如何取得|怎麼弄|哪來的|怎麼來|抓得到|哪裡有|怎麼養|怎麼孵/.test(q)) {
        return { key: 'pet-source', gen: function () { return _wcPetSourceAnswers(petName); } };
    }
    let mob = _wcFindMob(q);
    if (mob && /掉什麼|會掉|掉落物|出什麼|噴什麼|有什麼寶/.test(q)) return { key: 'mob-drop', gen: function () { return _wcMobDropAnswers(mob); } };
    let map = _wcFindMap(q);
    if (map && /什麼怪|哪些怪|出怪|怪物|有什麼/.test(q)) return { key: 'map-mobs', gen: function () { return _wcMapMobAnswers(map); } };
    if (item && /有什麼用|幹嘛的|做什麼|用途|效果|能力|說明|好用嗎/.test(q)) return { key: 'item-info', gen: function () { return _wcItemInfoAnswers(item.id); } };
    return null;
}

// ---- 主題表：關鍵字 → 答案產生器（回傳字串陣列，隨機取一句）----
const WC_TOPICS = [
    {
        key: 'spot', kw: ['練功', '練等', '打怪', '升級', '衝等', '哪裡打', '去哪', '刷怪', '練級'],   // ⚠️ v3.6.61 移除「經驗」：傭兵經驗/死亡噴經驗類問題會被它搶走
        gen: function (q) {
            let lv = _wcLevelFromText(q, _wcMyLv());
            let spots = _wcSpotsForLevel(lv);
            if (!spots.length) return ['這等級我也不確定，你自己開地圖選單掃一輪比較快。'];
            let names = spots.map(s => `${s.name}（怪 Lv.${s.min}~${s.max}）`);
            return [
                `Lv.${lv} 的話我都掛 ${names[0]}，怪的等級跟你差不多打起來最順。` + (names[1] ? `不想擠的話 ${names[1]} 也可以。` : ''),
                `${lv} 級推薦 ${names.slice(0, 2).join('、')}，選怪等貼近自己的，經驗跟安全性最平衡。`,
                `我 ${lv} 級是在 ${names[0]} 練起來的，打不動就往回退一張圖，硬打只是浪費藥水。`
            ];
        }
    },
    {
        key: 'class', kw: ['怎麼玩', '玩法', '強嗎', '好玩嗎', '推薦職業', '職業', '選什麼', '哪個職業'],
        gen: function (q) {
            let cls = _wcClassFromText(q) || _wcMyCls();
            let name = _wcClsName(cls);
            let ms = _wcMasteryNames(cls);
            let msTxt = ms.length ? `精通有 ${ms.slice(0, 4).join('／')}，選一個就定生涯，想清楚再點。` : '';
            let flavor = ({
                knight: '血厚耐打，看破殺戮全靠近戰普攻，武器攻速比傷害重要。',
                mage: '站遠放技能，MP 跟施法速度是命脈，記得把魔法書買齊。',
                elf: '屬性水晶決定你能學什麼，弓手跟劍術兩條路差很多。',
                dark: '出血跟劇毒疊起來很兇，但很脆，靠迴避活著。',
                royal: '傭兵基礎上限 3，每 15 點魅力多帶 1 名，最多 7 名；魅力只增加人數，不增加傭兵能力。',
                dragon: '鎖鏈劍弱點曝光是核心，龍魔法吃 HP 不是 MP，別放到自己死。',
                warrior: '副手武器是專利，雙武器 proc 全開，負重要顧好。',
                illusion: '奇古獸普攻直接算魔法傷害，幻覺光環全隊吃得到。'
            })[cls] || '';
            return [
                `${name}？${flavor}${msTxt}`,
                `玩 ${name} 就記住：${flavor || '裝備跟精通配好，剩下就是掛機。'}`,
                `${name} 我練過，${flavor}${ms.length ? `精通我選 ${ms[0]}，不後悔。` : ''}`
            ];
        }
    },
    {
        key: 'gear', kw: ['裝備', '武器', '穿什麼', '拿什麼', '推薦裝', '神裝', '防具', '要什麼裝'],
        gen: function (q) {
            let cls = _wcClassFromText(q) || _wcMyCls();
            let name = _wcClsName(cls);
            let w = _wcGearFor(cls, 'wpn').slice(0, 40);
            let a = _wcGearFor(cls, 'armor').slice(0, 25);
            let pickW = _wcPick(w.slice(0, 12)), pickA = _wcPick(a.slice(0, 10));
            let lines = [];
            if (pickW) lines.push(`${name} 的話武器抓 ${pickW.n} 這種等級的就夠用很久了。`);
            if (pickA) lines.push(`防具先把 ${pickA.n} 弄到手，AC 比多幾點傷害實在。`);
            if (!lines.length) lines.push(`${name} 的裝備你直接翻裝備收集冊，可以裝的都會亮起來。`);
            return [
                lines.join(''),
                `別急著追神裝，${name} 前期把武器強化衝上去比換裝有感；有閒錢再往 ${pickW ? pickW.n : '高階武器'} 換。`,
                `我 ${name} 現在用 ${pickW ? pickW.n : '手邊最好的武器'}，${pickA ? `身上 ${pickA.n}` : '防具隨便穿'}，掛機夠了。`
            ];
        }
    },
    {
        key: 'money', kw: ['賺錢', '金幣', '賺', '窮', '沒錢', '存錢', '換錢', '不掉錢', '掉錢', '怎麼賺', '賣什麼'],
        gen: function () {
            return [
                '打怪掉的雜物別丟，開自動販賣設一設，掛一晚上金幣自己進來。',
                '缺錢就去打你打得動的最高等地圖，怪等越高金幣掉越多，別在低等圖磨。',
                '潘朵拉黑市的收購單有時候價很甜，順手看一下再決定要不要賣商店。',
                '想快就去接玩家收購，世界頻道那些叫賣的出價常常比商店高。'
            ];
        }
    },
    {
        key: 'enhance', kw: ['強化', '衝裝', '幾轉', '卷軸', '+6', '+7', '+8', '+9', '衝到', '衝武', '衝防', '安定值', '安定', '衝壞', '爆裝', '失敗'],
        gen: function () {
            return [
                '衝裝就是天堂經典規則：武器 1/3、防具看目前強化值，安定值以內才安全，超過就是賭。',
                '別想著 SL 大法，這裡的強化結果是獲得當下就決定好的，讀檔重來也一樣。',
                '祝福卷軸留給高強化再用，低強化用一般的就好，不然很浪費。',
                '衝壞了就當作繳學費，我+9 那把也是炸了六隻才出來的。'
            ];
        }
    },
    {
        key: 'affix', kw: ['詞綴', '祝福', '祝福嗎', '有祝福', '祝福裝', '遠古裝', '遠古詞', '屬性武器', '武器屬性', '屬性詞', '碧恩', '賦予屬性', '屬性強化', '上屬性', '洗屬性', '五階屬性', '屬性魔法', '附加魔法', '重抽魔法', '觸發技能'],
        gen: function () {
            return [
                '現行掉落、製作、潘朵拉與血盟管道只會隨機出現「祝福的」詞綴，機率 1%；屬性與遠古詞綴要去象牙塔找碧恩處理。',
                '別再照舊攻略 SL 三詞綴了，現在隨機來源只有 1% 祝福；武器屬性跟遠古能力是碧恩那條系統。',
                '祝福是取得裝備時的隨機驚喜，屬性和遠古不是同一個抽法。想洗那兩種就去象牙塔，別在掉落畫面跟自己過不去。',
                '五階屬性武器還能拿同屬性卷軸找碧恩附加或重抽屬性魔法；遺物武器、本身就有非屬性卷觸發技能的武器不能附加。'
            ];
        }
    },
    {
        key: 'autocast', kw: ['自動施放', '技能設定', '魔法設定', '攻擊技能下拉', '輔助技能', '狀態技能', '不會放技能', '一直放技能', '怎麼放技能'],
        gen: function () {
            return [
                '傷害技能放在攻擊技能設定；火牢、冰雪颶風這種持續型是輔助／狀態技能，要在自動化的增益區勾選，不會出現在攻擊技能下拉。',
                '傭兵會讀來源角色存檔的技能與自動化設定。先切回那隻角色勾好、存檔，再重新招募或更新快照。',
                '技能沒放先檢查四件事：有沒有學、MP或HP夠不夠、自動化有沒有勾、技能是否被分在攻擊／治療／輔助的另一欄。'
            ];
        }
    },
    {
        key: 'pet', kw: ['寵物', '夥伴', '捕捉', '誘捕', '進化', '蜥蜴', '誘食', '寵物蛋', '怎麼孵', '保管', '出戰', '收回', '減傷', '傷害減免', '袋鼠', '高等袋鼠', '魔法娃娃', '娃娃', '娃娃商人', '娃娃合成', '娃娃重組', '全部合成', '全部重組'],
        gen: function () {
            return [
                '寵物去包武那邊保管，最多 32 隻；誘捕要帶對應的誘食，打到剩殘血才抓得到。',
                'Lv30 以後拿進化果實可以進化，數值差很多，別急著放生。',
                '王族有寵物精通，傷害命中直接乘上去，其他職業就當多一個打手。',
                '寵物也能裝武器防具，諾斯那邊可以做，別讓牠白板上場。',
                '寵物保管上限 32 隻，出戰、收回、裝備後會維持原本捲動位置，不用每次從頂端重找。',
                '寵物也有隨機傷害減免：物理型看 AC/3、特殊型 AC/4、魔法型 AC/5；袋鼠跟高等袋鼠普攻還會穿透怪物減傷。',
                '魔法娃娃商人那邊有合成／重組，也有全部合成／全部重組；鎖定的娃娃不會被動到。'
            ];
        }
    },
    {
        key: 'merc', kw: ['傭兵', '隊友', '組隊', '幫手', '雇傭', '招募', '能招', '怎麼招', '傭兵公會', '卡住', '技能卡住', '屠宰者', '七個傭兵', '7個傭兵', '外觀', '變身能力'],   // ⚠️ v3.6.61 「召喚」移到獨立 summon 主題
        gen: function () {
            return [
                '傭兵在傭兵公會招，記得進隊伍面板把自動維持的技能勾一勾，不然他們只會站著普攻。',
                '傭兵吃自己的存檔等級跟裝備，換角前先想清楚，來源角色改了會被自動解散。',
                '非王族可帶 3 名傭兵；王族也是從 3 名起算，每 15 點魅力多 1 名，60 魅時最多 7 名。',
                '召喚物走另一套，召喚控制戒指可以指定要召什麼，別用預設的。',
                '傭兵攻擊技能如果 MP/HP 不夠或條件不符，現在會回普攻節奏，不會假裝施法成功又吃冷卻卡住。',
                '王族魅力夠可以帶到 7 名傭兵，場上都會顯示外觀；傭兵吃來源角色的等級、裝備、自動技能與變身能力快照。'
            ];
        }
    },
    {
        key: 'mastery', kw: ['精通', '轉職', '技能點', '選哪個精通'],
        gen: function (q) {
            let cls = _wcClassFromText(q) || _wcMyCls();
            let ms = _wcMasteryNames(cls);
            if (!ms.length) return ['精通看你職業，能力面板裡面有四個方向可以選，選了就不能改。'];
            return [
                `${_wcClsName(cls)} 可以選 ${ms.join('／')}，選了不能改，先看清楚說明再點。`,
                `我 ${_wcClsName(cls)} 是選 ${_wcPick(ms)}，掛機流很順；你要是玩法不同就自己斟酌。`,
                `精通這種東西沒有標準答案，${ms.slice(0, 2).join('跟')} 都有人吹，看你想打單體還是群怪。`
            ];
        }
    },
    {
        key: 'trial', kw: ['試煉', '任務', '轉生', '任務怎麼', '接任務'],
        gen: function (q) {
            // ⚠️ v3.6.61 「攻城任務怎麼做」類問題別回職業試煉：改講攻城流程
            if (/攻城|血盟|城堡/.test(q)) return [
                '攻城從血盟那邊發動，限時內把城門跟守護塔打掉就贏，贏了直接傳進城。',
                '只有王族能宣戰攻城；其他職業回血盟找自己的王族角色發動就行。'
            ];
            return _wcTrialAnswers(q);
        }
    },
    {
        key: 'relic', kw: ['遺物', '傳說', '稀有', '極品'],
        gen: function () {
            return [
                '遺物非常稀有，別特地去farm，掛久了自然會遇到。',
                '想指定拿就去潘朵拉黑市搜索，100 顆龍鑽一次，未知遺物那個選項還保證是你圖鑑沒有的。',
                '遺物不能強化也不能祝福，拿到什麼就是什麼。',
                '別看遺物就以為一定強，有幾件是負面效果，看清楚說明再穿。'
            ];
        }
    },
    {
        key: 'pride', kw: ['傲慢之塔', '傲塔', '支配符', '爬塔', '潔尼斯女王'],
        gen: function () {
            return [
                '傲慢之塔先從入口一路往上爬；首次擊敗 10 樓的潔尼斯女王後，入口才會開放 2～10 樓直接挑戰。',
                '11 樓以上要靠攀登、移動卷軸或對應支配符。持有該樓支配符可在樓層內傳送，但排名挑戰會封鎖所有傳送。',
                '傲塔不是選一樓就空降。先打樓梯或每十樓頭目往上推，支配符是讓該樓傳送與魔物追蹤更方便。',
                '支配符要找傲慢之塔入口的巴姆特製作，材料打對應樓層的怪收集；做好了那段樓層行動會方便很多。'
            ];
        }
    },
    {
        key: 'rift', kw: ['時空裂痕', '裂痕', '龜裂之核', '裂痕碎片'],
        gen: function () {
            return [
                '進時空裂痕要 1 顆龜裂之核；去希培利亞找巴特爾，用時空裂痕碎片×100 製作。',
                '裂痕進去後不能傳送，首隻強制頭目在 5 分鐘後出現；離開依停留時間結算排名與待領獎勵。',
                '裂痕獎勵要離場後回入口領，領完才能再進。想看到四大龍要撐過 30 分鐘後才會進怪物池。'
            ];
        }
    },
    {
        key: 'sherine', kw: ['席琳世界', '席琳的世界', '席琳模式', '瘋狂席琳', '席琳結晶', '席琳遺骸'],
        gen: function () {
            return [
                '席琳的世界會強化怪物，也提高一般掉落倍率；瘋狂席琳更兇。席琳結晶則依怪物等級與頭目身分另算，不是固定一個掉率。',
                '席琳結晶可以去席琳神殿找伊奧，1 顆換 1 件指定部位的席琳遺骸；遺骸詞綴還能找菈克希絲處理。',
                '開席琳前先確認自己打怪效率，倍率高不代表被怪打趴也划算。普通打得快，常常比瘋狂模式硬撐更有效率。'
            ];
        }
    },
    {
        key: 'clan', kw: ['血盟', '攻城', '城堡', '公會', '盟主', '盟主祝福', '貢獻', '宣戰', '血盟buff', '血盟BUFF', '魔物追蹤', '王族搜索狀', 'NPC血盟', '士氣', '仇恨', '敵盟', '團戰', '敵對', '單方面宣戰', '互宣'],
        gen: function () {
            return [
                '血盟捐金幣或龍鑽都能加貢獻，貢獻直接變血盟經驗。',
                '攻城要在時間內把城門跟守護塔打掉，贏了就直接傳送進城。',
                '城主頭上會有王冠，王族才顯示，其他職業就算佔了城也沒有。',
                '血盟 Buff 加入血盟後自動常駐，不再吃王族搜索狀；魔物追蹤現在改成花 10 萬金幣。',
                'NPC 血盟才有隱藏士氣跟仇恨值；仇恨高會宣戰，玩家王族也能主動宣戰，互宣時整個模式會強制 PVP。',
                '攻城打有 NPC 血盟守的城，敵軍重生更快，也可能刷出該血盟玩家；團戰會把一般怪清掉改補敵盟玩家。'
            ];
        }
    },
    {
        key: 'stat', kw: ['加點', '屬性', '力量', '敏捷', '體質', '智力', '精神', '魅力', '素質'],
        gen: function (q) {
            let cls = _wcClassFromText(q) || _wcMyCls();
            let hint = ({
                knight: '力量體質為主，敏捷夠用就好。', mage: '智力優先，精神顧 MP 恢復。',
                elf: '看你走弓還是劍，弓堆敏捷，劍堆力量。', dark: '敏捷堆迴避，力量顧傷害。',
                royal: '魅力直接決定寵物跟傭兵，別忽略。', dragon: '力量體質，龍魔法吃 HP 所以體質更重要。',
                warrior: '力量為主，負重不夠就補體質。', illusion: '智力為主，奇古獸傷害算魔法。'
            })[cls] || '看你的主要輸出來源堆對應屬性。';
            return [
                `${_wcClsName(cls)}：${hint}上限是 100，內部抗性類的加成到 60 就頂了。`,
                `${hint}忘記加了可以用回憶蠟燭重置，不用重練。`,
                `別平均分配，${hint}`
            ];
        }
    },
    {
        key: 'poly', kw: ['變身', '變形', '移動速度', '移速', '加速', '攻擊速度', '攻速', '風之疾走', '神聖疾走', '精靈餅乾', '勇敢藥水', '勇水', '綠水', '變卷', '變戒', '切割', '攻速裝', '攻速加成', '速度公式', '新公式', '施法速度', '施速'],
        gen: function () {
            return [
                '變身會直接覆蓋你的攻速跟走速，有變形控制戒指就可以指定，隨機的很看運氣。',
                '移動速度只看主玩家。加速、勇敢、行走加速、疾走與裝備移速採相乘；神聖疾走和風之疾走都是速度×1.33，而且彼此互斥。',
                '風之疾走生效時會取代精靈餅乾的移動速度加成，但餅乾的攻擊速度仍保留；舊存檔若兩種疾走同時殘留，以風之疾走為準。',
                '攻速、施法速度跟裝備加成都走新的乘算公式；速度太高只會碰到 0.1 秒 tick 上限，不會因為太快卡普攻或技能卡。'
            ];
        }
    },
    {
        key: 'card', kw: ['卡片', '收集冊', '圖鑑', '收藏', '殺生石', '玉藻', '九尾狐', '金卡', '白面金毛九尾狐'],
        gen: function () {
            return [
                '卡片打怪隨機掉，同地區收滿有加成，值得順手收。',
                '收集冊在「收藏」面板打開，裝備、道具、卡片、遺物各一本。',
                '裝備收集冊有全收集加成，某些部位收滿會給永久屬性，別把裝備全賣了。',
                '殺生石死亡掉卡不是只有一種，玉藻、九尾狐、殺生石三種都有機會出；看到圖沒對上多半是資料或快取還沒更新。'
            ];
        }
    },
    // ===== v3.6.61 依巴哈玩家實際問法補的六個主題 =====
    {
        key: 'death', kw: ['死掉', '死亡', '死了', '噴經驗', '掉經驗', '扣經驗', '陣亡', '復活', '買回經驗', '贖回', '聖使', '阿卡塔', '一直死', '攻城死亡', '攻城區死亡', '噴裝備', '噴道具', '紅人掉裝'],
        gen: function () {
            return [
                '一般模式死亡不會噴經驗；經典模式才會扣，被怪打死就回村重整旗鼓。',
                '經典模式死掉的經驗可以去亞丁找聖使阿卡塔花金幣買回一半，紀錄筆數有限，別拖太久。',
                '一直死就是等級或裝備跟不上：退一張圖練、把自動喝水的門檻調高，比原地送頭有效。',
                '攻城區不管是邪惡玩家還是敵人死亡，都不會噴裝備；經典模式在攻城區死亡也不扣經驗。',
                '紅名低於很深的邪惡值才有死亡掉物品風險，攻城區不吃這條。'
            ];
        }
    },
    {
        key: 'pvp', kw: ['PVP', 'pvp', 'Pvp', '性向', '紅人', '紅名', '藍名', '白名', '洗白', '開紅', '正義值', '邪惡值', '噴裝', '復仇', '嗆他', '嘲諷', '封鎖', '追殺', '玩家NPC', '互噴', '垃圾話', '世界頻道', '假玩家', '假玩家名字', '名字顏色'],
        gen: function () {
            return [
                '殺怪會慢慢累積性向值；殺白名、藍名玩家NPC會扣，扣多了就變紅名。開 PVP 後野外會遇到玩家NPC互打。',
                '紅名想洗白就乖乖打怪把性向養回來；殺紅名不扣性向。越紅死亡越危險，裝備是真的會消失，想清楚再走這條路。',
                '正義值高補血法術會變強，究極光裂術也只有正義玩家能用；走正義路線不是只有名字好看。',
                '被玩家NPC打死可以從 PVP 清單復仇追殺回去；嗆聲也可能被記仇來野外堵你，開嘴之前先秤一下自己斤兩。',
                '殺怪性向 +1；殺白名玩家 NPC 扣 5000，殺藍名扣 10000，殺紅名不扣，攻城區不列入。',
                '復仇現在不用花金幣，按「嗆他」選一句話就會讓對方加入追殺；打贏才會從名單消失。',
                '嘲諷玩家 NPC 時，中立 50%、正義 20%、邪惡 100% 會追殺；沒追殺也可能把你封鎖。',
                '野外、黑市收購、世界頻道這些假玩家名字都走同一個名字池，顏色只看該 NPC 性向。'
            ];
        }
    },
    {
        key: 'blackmarket', kw: ['黑市', '潘朵拉', '龍鑽', '龍之鑽石', '收購', '鑽收', '金幣收購', '收購NPC', '叫賣NPC', '未知遺物', '搜索遺物', '喊收', '吵死了', '驅離', '出價太低', '低價'],
        gen: function () {
            return [
                '黑市在潘朵拉那邊，商品會定時輪換，看到想要的別猶豫，晚五分鐘就被掃光了。',
                '龍之鑽石主要靠村莊裡喊收購的玩家：把他要的東西給他就換龍鑽，物品放倉庫也算數。',
                '龍鑽存夠可以在黑市收購搜索指定類型的遺物；選「未知遺物」保證出圖鑑還沒收錄的，蛋類遺物只有這個管道。',
                '黑市也能自己出價收購：出得比行情高就會上架，掛著等貨上門就好。',
                '世界頻道喊「鑽收」是龍鑽收購，「收」是金幣收購；兩種 NPC 可以同一個安全區同時出現。',
                '金幣收購 NPC 的出價看物品售價跟突破，紅人有機會開低於基本價；低價你罵他通常很合理。',
                '安全區收購 NPC 可以直接驅離，但那個安全區的兩小時倒數還是照跑。'
            ];
        }
    },
    {
        key: 'summon', kw: ['召喚', '召喚物', '造屍', '屬性精靈', '召喚術', '召喚控制', '召喚戒指'],   // ⚠️ 「召喚物死掉…」的「死掉」會被 death 主題搶走 → 顯式列 '召喚物' 加權
        gen: function () {
            return [
                '召喚術是法師技能，等級越高能召的怪越強；想指定召什麼就戴召喚控制戒指來選。',
                '造屍術要對擊倒的怪施放，等級高殭屍跟著變強；妖精的屬性精靈則看你當初簽的屬性契約。',
                '召喚物有自己的血條，死了會自動重新施展再扣一次 MP；打王時牠們也會幫你分攤火力。',
                '傭兵召的是他自己的，每個法師傭兵各自一組、血條分開算；同一個傭兵召多隻會併成一條血顯示，但攻擊次數還是照隻數跑，不會變成只打一次。',
                '你自己召多隻是各自獨立的個體，一隻一條血、出手時間也錯開；被打死的只有那一隻，其他照打。'
            ];
        }
    },
    {
        key: 'boss', kw: ['吉爾塔斯', '血壁', '反射', '打不贏', '打不動', '滅團', '頭目', '王怎麼打', '巴風特', '四大龍', '安塔瑞斯', '法利昂', '林德拜爾', '巴拉卡斯', '丹特斯'],
        gen: function () {
            return [
                '頭目會持續回血，太久沒吃到物理傷害還會回得更兇；輸出不能斷，會污濁之水的先上，能壓他的恢復。',
                '吉爾塔斯的反射類技能被彈到基本必死，硬拚不如帶完整的召喚球：撤退時消耗一顆保留他的血量，打補給消耗戰磨死他。',
                '打不動就別硬撐：回頭補強化、換一張打得動的圖，或把傭兵、寵物、召喚全帶上，頭目戰拚的是整隊輸出。'
            ];
        }
    },
    {
        key: 'system', kw: ['刪除角色', '刪角', '匯出', '匯入', '斷線', '登出', '快取', '舊圖', '重新整理', '換角色', '多開', '離線', '備份', '存檔不見', '角色不見', '倉庫', '搜尋', '龍鑽', '龍之鑽石', '寵物還原', '傭兵還原', 'file', 'file://', '記憶體'],
        gen: function () {
            return [
                '角色管理在登入畫面：要先刪除角色才能創新或匯入，匯出進度也在那邊，記得定期備份。',
                '版本更新後畫面怪怪的、圖沒換新，就按 Ctrl+Shift+R 硬重載，把快取的舊檔清掉。',
                '這遊戲要開著分頁才會跑，沒有離線掛機；怕進度不見就常按匯出進度留一份檔。',
                '存檔會自動進行，也可以手動點儲存；角色突然不見先確認瀏覽器沒清除網站資料，有匯出檔就能救回來。',
                '倉庫搜尋輸入兩個字以上就會做模糊搜尋，名字記不完整也找得到。',
                '匯出會帶角色、倉庫跟龍之鑽石；匯入時照選項還原倉庫與寵物資料，隊伍狀態會整理避免跨角色出戰錯亂。',
                '多開很吃記憶體，正常單分頁不該一直膨脹到十幾 GB；遇到那種狀況先硬重載、關插件，再看是不是瀏覽器或快取問題。'
            ];
        }
    },
    // ===== v3.6.68 依實際玩家回報的疑問補的三個主題 =====
    {
        key: 'lock', kw: ['鎖定', '上鎖', '解鎖', '誤賣', '誤賣裝備', '被賣掉', '不小心賣', '廢品', '自動販賣', '保護物品', '不想賣', '沒疊在一起', '不會疊', '疊不起來', '分成兩堆'],   // ⚠️ '誤賣裝備' 是為了壓過 gear 的 '裝備'（同長度平手時排前面的主題會贏）
        gen: function () {
            return [
                '怕誤賣就在物品視窗按鎖定。鎖定的東西不會被廢品勾選、自動販賣、卡片與娃娃合成、製作扣料吃掉，紅名死亡也不會掉。',
                '鎖定的物品是刻意獨立一堆的，這樣製作扣材料才不會偷偷把你保護的那件算進去；解鎖之後會自己併回原本那疊，不用手動整理。',
                '鎖定件存不進倉庫，也不列入快速強化跟快速廢品；要動它就先解鎖。試煉道具被鎖住也交不出去，卡關的話先檢查有沒有上鎖。'
            ];
        }
    },
    {
        key: 'maxlevel', kw: ['滿等', '等級上限', '練滿', '100等', '100級', '經驗歸零', '沒經驗', '不加經驗', '拿不到經驗', '練到頂', '練完了'],
        gen: function () {
            return [
                '等級上限是 100，到頂之後經驗就不會再往上累積了。',
                '滿等之後統計面板還是會記經驗，那是「照現在的效率應該拿到多少」的參考值，用來比裝備跟練功地點好不好，不是真的入帳。',
                '練滿之後目標就換成裝備跟收集：強化、遺物、卡片跟收集冊加成，還有攻城跟頭目，這些才是後期真正的成長。'
            ];
        }
    },
    {
        key: 'skillmorph', kw: ['爆裂的火球', '燃燒的火球', '火球', '技能變成', '技能不見', '技能消失', '放不出來', '放不出', '不能施放', '施放不了', '技能沒反應'],
        gen: function () {
            return [
                '有些裝備會直接改寫你的技能：穿上「烈焰巫師的正式長袍」，燃燒的火球就會變成爆裂的火球，傷害更高、MP 也吃比較多。',
                '爆裂的火球不是技能書學得到的，是長袍在施法瞬間幫你換的；脫掉長袍就變回原本的燃燒的火球，技能欄本身不會變。',
                '技能放不出來先看三件事：等級夠不夠、MP 夠不夠、是不是中了沉默或魔法封印。都沒問題的話重新整理一次，通常是版本快取沒更新。'
            ];
        }
    }
];

// ---- 嘲笑句（不回答問題，純路過洗頻）----
const WC_MOCK_LINES = [
    '這種問題也要問？自己按一下就知道了。',
    '又是這個問題，頻道每天都在問。',
    '你先自己玩過再來問好嗎。',
    '問這麼多不如去打怪。',
    '笑死，這也要問。',
    '我要是回答了，你是不是連按鍵都要我幫你按？',
    '新手是這樣的啦，慢慢就懂了（不會）。',
    '樓上不要教他，讓他自己撞牆比較快。',
    '這問題我上次回答過了，翻紀錄。',
    '先報等級跟裝備，不然沒人知道要怎麼回你。',
    '你這問法太籠統，我看不懂你想問什麼。',
    '別問了，玩就對了。',
    '先去新兵訓練場罰站三分鐘再回來問。',
    '你這問題連妖魔都聽不下去。',
    '回卷帶了嗎？等等問到一半又躺。',
    '先把紅水補滿，再來討論你的遠大夢想。',
    '裝備穿成這樣，怪物看到都想捐你金幣。',
    '你不是打不到，是怪物不想把東西給你。',
    '問掉率之前，先確認你真的有在打。',
    '這題我回答要收十萬金幣。',
    '叫三小，打開統計自己看。',
    '頻道不是許願池，你問三次掉率也不會變高。',
    '你再問一次，巴風特也不會主動寄給你。',
    '這個問題很有深度，深到我不想下去撿。',
    '我看你不是缺攻略，是缺一張回村卷軸。',
    '天堂哪有保證掉寶，只有保證你會爆裝。',
    '先說你是哪個模式，不然大家是在隔空算命。',
    '你裝備欄打開，我怕答案說完你還是打不動。',
    '怪沒死當然不會掉，你是不是本末倒置了。',
    '這問題問得很好，下次不要再問了。',
    '有人要帶這位新手去銀騎士村嗎？',
    '我懷疑你把地圖選單當裝飾。',
    '有沒有可能，NPC 已經把答案寫在說明上了。',
    '先看物品全名，不要拿兩個字叫大家猜。',
    '你說「那個東西」誰知道是哪個東西。',
    '等級不報、職業不報，連甘特都救不了你。',
    '別急，你再掛三天就會從疑問變成習慣。',
    '出這種問題，是不是剛被怪送回村。',
    '我也想知道怎麼一刀打爆吉爾塔斯，夢裡嗎。',
    '你要的是攻略，還是想聽大家一起安慰你。',
    '武器先拿正，再問為什麼沒傷害。',
    '這句看起來像你邊喝勇水邊打的。',
    '先按一次重新整理，很多靈異事件就會消失。',
    '不要什麼都說 BUG，有時候是你任務根本沒接。',
    '試煉沒接就去打，這叫自願加班。',
    '你打三隻沒掉就問機率，潘朵拉都笑了。',
    '你是不是以為 0.01% 是打十隻會出一件。',
    '這套問題我收過了，賣商店都嫌佔負重。',
    '大哥，物品名稱打完整很難嗎。',
    '你再講模糊一點，我就能完全不知道你在問什麼。',
    '先把自動化設定看完，傭兵不是讀心術士。',
    '沒有變戒還想指定變身，你當變卷會讀心喔。',
    '倉庫不是黑洞，先把搜尋條件清掉。',
    '你這配點很有個性，難怪怪物也特別照顧你。',
    '打王一直死還不換圖，這份堅持我給滿分。',
    '別人一晚打到，你掛十分鐘就上頻道了。',
    '天堂玩家的第一課：沒掉就是繼續打。',
    '天堂玩家的第二課：掉了也不要急著衝爆。',
    '先別喊改弱，你身上可能還穿著新手裝。',
    '這問題留給下一位勇者，我先回村。',
    '我本來想認真回，看到你的問法又放棄了。',
    '你算老幾，頻道客服嗎？',
    '來 PK 啊，打贏我就告訴你。',
    '問攻略可以，先交一張祝武當學費。',
    '你的角色可能沒問題，有問題的是操作角色的人。',
    '這不是卡關，是遊戲在勸你換裝。',
    '先去找倉庫番冷靜一下，再回來組織句子。',
    '連續問三次不會提高 NPC 認真回答率。',
    '你這題太天堂了，答案就是：繼續農。'
];
// 不相關閒聊：模擬世界頻道日常，故意不接玩家的問題。
const WC_CHAT_LINES = [
    '徵網公，會帶練、會哄人、不會突然消失的。',
    '徵網婆，女妖精佳，男妖精先不要密。',
    '有盟要收我嗎？每天上線但不一定說話。',
    '有沒有活人血盟收留邊緣人。',
    '最近股票大跌，虧到只敢買紅水。',
    '今天台股又綠一片，我的裝備倒是都白的。',
    '有人也是上班偷掛，老闆走過來就切視窗嗎？',
    '等等要開會，先幫我祈禱不要被抓到。',
    '午餐吃什麼？不要再叫我吃便利商店了。',
    '晚餐有人要一起吃鍋嗎，我不想再配紅水。',
    '我媽叫我去倒垃圾，先掛著。',
    '剛洗完澡回來，還是什麼都沒掉。',
    '你們都掛整晚嗎？我電腦風扇快起飛了。',
    '昨晚夢到打到神裝，醒來背包只有金屬塊。',
    '有人要陪我去傲塔嗎？我一個人會怕。',
    '收祝武，價格好談，亂開價直接封鎖。',
    '賣一堆用不到的法書，有需要自己密。',
    '誰有多的變卷，我剛剛又變成奇怪的東西。',
    '剛才衝裝連爆三件，我先離開電腦冷靜。',
    '今天不衝了，再衝我是小狗。',
    '我宣布退坑，明天記得叫我上線。',
    '有人看到我的網婆嗎？三天沒上線了。',
    '網公跟別人跑了，天堂果然比現實還殘酷。',
    '徵固定聊天的，別聊兩句就跑去打王。',
    '有女生玩家嗎？純好奇，沒有要密。',
    '樓上別裝女生了，上次語音都破功了。',
    '公主角色不代表本人是女生，醒醒。',
    '我只是想安靜掛機，怎麼每天都有人吵架。',
    '世界頻道今天比怪物還兇。',
    '剛上線，今天又改了什麼？',
    '有人整理更新內容嗎？我字太多會睡著。',
    '你們有沒有覺得潘朵拉今天特別黑。',
    '黑市又被誰掃光了，我只是晚來五分鐘。',
    '剛遇到一個紅人，嘴很秋但是跑很快。',
    '有人開 PVP 嗎？我開了又怕被打。',
    '我性向快紅到底了，村莊的人看我的眼神都變了。',
    '剛被 NPC 嗆完又追殺，這遊戲的人情味好重。',
    '有沒有不打架只聊天的血盟。',
    '徵攻城打手，會按回村也算會玩。',
    '攻城缺人，躺著喊加油的也可以。',
    '誰拿到城了？我要去看王冠。',
    '今天運氣不錯，先來頻道吸一點仇恨。',
    '我朋友第一次玩就打到好東西，合理嗎？',
    '別人都有遺物，只有我有毅力。',
    '我的掉寶運是不是被角色名字吃掉了。',
    '有人跟我一樣只收集卡片不練等嗎？',
    '金卡又重複，娃娃商人看到我都笑了。',
    '剛合娃娃全滅，今晚不想說話。',
    '魔法娃娃到底是來幫忙還是來嘲笑我的。',
    '寵物比我還強，我是不是該退到後面。',
    '我的傭兵裝備比本尊好，尊嚴有點受傷。',
    '王族帶七個小弟真的很有排面。',
    '有人專門練七隻法師給王族帶嗎？',
    '法師沒魔的時候跟村民差不多。',
    '騎士就是穩，穩穩地打、穩穩地沒掉東西。',
    '妖精今天又在吵風妖火妖誰比較強。',
    '黑妖一刀很帥，躺下去也很快。',
    '戰士副手終於有存在感了。',
    '幻術士玩家都去哪了？我很久沒看到同類。',
    '龍騎士不要再拿 HP 當 MP 用到自己倒地了。',
    '有人在新兵訓練場嗎？我回去懷舊一下。',
    '說話之島還是最有家的感覺。',
    '歐瑞太冷了，我角色站著都像在發抖。',
    '日出之國風景很好，怪物打人也很痛。',
    '夢幻之島今天有沒有開張？',
    '有人掛遺忘之島掛到忘記回來嗎？',
    '時空裂痕一進去就出不來，我先去買飲料。',
    '傲塔爬到一半斷線的人可以來這裡集合。',
    '吉爾塔斯看到我應該也會先笑一下。',
    '剛才王反射一下整隊都沒了，畫面很乾淨。',
    '剛按嗆他之前很勇，按完突然覺得人生很多選擇。',
    '金幣都拿去強化了，現在連水都喝不起。',
    '龍鑽留著不用很浪費，用了又很心痛。',
    '有人要收材料嗎？倉庫快塞不下了。',
    '我的倉庫不是倉庫，是考古遺址。',
    '每次整理背包都會發現三個月前的垃圾。',
    '今天只想聊天，不想看掉率。',
    '頻道怎麼突然安靜，大家都睡著了嗎？',
    '我先去吃飯，回來如果出王記得叫我。',
    '等等要出門，角色就交給命運了。',
    '週末就是要整天掛著什麼都不做。',
    '明天還要上班，為什麼我還在看角色揮刀。',
    '有人也是聽著打怪音效睡覺的嗎？',
    '我只是路過，你們繼續聊。',
    '先別問我，我現在忙著跟倉庫奮鬥。',
    '今天心情不好，誰來講個笑話。',
    '樓上那個名字我昨天是不是看過。',
    '這頻道人好多，但需要幫忙時都突然消失。',
    '我去泡咖啡，等一下回來看有沒有奇蹟。',
    '有人要一起賭潘朵拉嗎？輸了各自負責。',
    '我剛算了一下，退坑可以省很多電費。',
    '不要問我幾歲，天堂玩家沒有年齡。',
    '以前的網咖味道突然回來了。',
    '看到這個頻道，突然想起以前在村口聊天的日子。',
    '我朋友說他只掛一下，結果天亮了。',
    '今天的目標很簡單，不爆裝就算贏。',
    '有人想換一個比較歐的角色名字嗎？',
    '剛取完中二名字，感覺掉寶率提高了。',
    '你們繼續，我只是來刷存在感的。',
    '剛想用起死回生術炸死亡騎士，看來是我天真了。',
    '掛了一整晚，收穫是三張普卡跟一背包皮革。',
    '八開的大哥，你的電腦是水冷還是氣冷？',
    '嗆完NPC被追殺了兩小時，我學乖了。',
    '純坦王帶七隻小弟打王，我在旁邊看得比打的還爽。',
    '這兩把弓面板只差一點，實際打起來差一截，玄學。',
    '有人知道精通任務的怪在哪嗎？我打到懷疑人生。',
    '開狂暴又開PK的勇者，先幫你點蠟燭。'
];
// 額外 500 種跨主題閒聊：七類各有 10 種開場 × 10 種內容，交錯取樣避免單一主題壟斷。
const WC_EXTRA_CHAT_TOPICS = [
    {
        key: 'economy',
        leads: [
            '最近在看經濟新聞，', '剛才吃飯聊到景氣，', '我朋友又在抱怨物價，', '掛機時順便聽財經節目，', '今天路過超商看了價格，',
            '月底算完帳以後，', '想到薪水跟消費，', '有人也在研究總體經濟嗎？', '先不聊打寶，聊點經濟，', '剛繳完帳單，'
        ],
        remarks: [
            '物價漲得比經驗條快，薪水卻像卡在新手村。',
            '升息降息講半天，我只知道每個月能花的錢又少了。',
            '景氣好不好很難說，便當變貴倒是每天都看得見。',
            '大家開始省非必要支出，我的龍鑽也跟著進入冷凍期。',
            '通膨最可怕的地方，是同樣的金幣買不到昨天的東西。',
            '消費信心聽起來很專業，實際上就是敢不敢打開錢包。',
            '匯率一動，旅遊跟進口商品的價格就跟著一起晃。',
            '經濟成長如果沒反映到生活，數字再漂亮也很難有感。',
            '房租、交通和吃飯一起漲，月底比打王還有壓力。',
            '市場最怕大家都沒信心，連想花錢的人都會先觀望。'
        ]
    },
    {
        key: 'science',
        leads: [
            '剛看完一篇科普，', '掛機時聽到一集科學節目，', '今天突然想到一個科學問題，', '有人也喜歡看宇宙影片嗎？', '先離題聊一下科學，',
            '剛剛翻到一篇研究，', '我朋友傳了一段科學短片，', '每次看到自然紀錄片，', '睡前不小心看到科普頻道，', '打怪打到開始思考宇宙，'
        ],
        remarks: [
            '黑洞不是一個洞，而是連光都很難逃離的極端區域。',
            '人類對深海的了解還不完整，未知區域比想像中多。',
            '量子世界跟日常直覺差很多，看懂一半就覺得很神奇。',
            '光走得那麼快，從遙遠星系過來仍然要花非常久。',
            '大腦睡覺時也沒有完全休息，還在整理記憶和資訊。',
            '很多看似簡單的材料，換個微觀結構就會出現不同性質。',
            '氣候是一整套長期系統，不能只拿某一天冷不冷來判斷。',
            '演化不是朝著完美前進，而是適應當下環境留下來。',
            '太空中的距離大到很難直覺理解，地圖縮小也救不了。',
            '科學最有趣的是答案會被新證據修正，不是一次說死。'
        ]
    },
    {
        key: 'stocks',
        leads: [
            '今天盯了一下盤，', '剛打開股票軟體，', '朋友又在群組報明牌，', '掛機時順便看了走勢，', '有人今天也在看股票嗎？',
            '剛看到市場一根長紅，', '新聞一出盤面就開始晃，', '我本來只想定期看一下，', '收盤後回頭看，', '最近研究投資才發現，'
        ],
        remarks: [
            '追高的衝動跟衝裝很像，按下去之後才開始後悔。',
            '漲的時候怕沒上車，跌的時候又怕車根本沒有煞車。',
            '成交量突然放大不一定是好事，還是要看發生了什麼。',
            '只聽別人一句話就買，最後通常連為什麼賠都說不清楚。',
            '分散風險聽起來無聊，真的遇到震盪時才知道有用。',
            '市場每天都有故事，帳面數字才是最誠實的結局。',
            '短線消息跑得比人快，看到新聞時常常已經反映一段了。',
            '能不能承受波動比猜對方向重要，不然晚上根本睡不著。',
            '賺錢時容易把運氣當實力，回檔才會重新認識自己。',
            '看懂公司在做什麼，比只看代號和顏色可靠得多。'
        ]
    },
    {
        key: 'football',
        leads: [
            '剛看完足球精華，', '有人昨晚也熬夜看球嗎？', '聊到足球我就想到，', '掛機配足球轉播剛剛好，', '今天那場足球真的有意思，',
            '朋友一直跟我爭戰術，', '每次看強隊控球，', '足球比賽最刺激的是，', '剛才看到一個漂亮進球，', '先問一下有沒有足球迷，'
        ],
        remarks: [
            '高位逼搶看起來很兇，體力和站位一亂就會被直接打穿。',
            '控球率高不代表一定贏，最後還是要把機會變成進球。',
            '門將撲出單刀的瞬間，比我打到稀有裝還讓人清醒。',
            '越位判定差一點點就完全不同，慢動作看了還是會吵。',
            '補時進球最折磨人，前面九十分鐘像都在替最後鋪路。',
            '定位球練得好真的能救命，僵局常常就靠那一次。',
            '反擊快起來只要幾腳傳球，整條防線就被拉開了。',
            '有些前鋒整場沒什麼鏡頭，出現一次就把比分改掉。',
            '中場能不能把節奏穩住，常常比單看明星球員重要。',
            '德比戰不只比技術，氣氛和壓力也會直接影響表現。'
        ]
    },
    {
        key: 'basketball',
        leads: [
            '剛看完籃球精華，', '有人今天也在看籃球嗎？', '掛機時配一場球賽，', '聊到籃球我最在意，', '剛才那場第四節太扯了，',
            '朋友又在爭誰比較強，', '每次看到最後一攻，', '籃球比賽節奏一快，', '剛看到一個漂亮助攻，', '先問頻道裡有沒有籃球迷，'
        ],
        remarks: [
            '三分投得準很有氣勢，但防守輪轉沒做好一樣守不住。',
            '最後兩分鐘可以打很久，每一次暫停都把緊張感拉滿。',
            '籃板不是只看身高，卡位和預判落點同樣重要。',
            '控球的人能改變節奏，整隊進攻看起來就完全不一樣。',
            '罰球平常最基本，關鍵時刻卻最容易考驗心理。',
            '快攻一跑起來很漂亮，傳球慢半拍機會就消失了。',
            '禁區防守需要整隊幫忙，不是丟給中鋒一個人處理。',
            '替補上來能不能維持強度，常常決定下半場還有沒有力。',
            '手感熱的時候怎麼投都有，冷掉時空檔也像被上了鎖。',
            '真正好看的助攻，是接球的人不用調整就能直接出手。'
        ]
    },
    {
        key: 'sports',
        leads: [
            '最近想開始運動，', '有人掛機時也會順便伸展嗎？', '今天出去走了一圈，', '久坐之後才發現，', '朋友約我週末去運動，',
            '聊到維持體力，', '我最近在研究訓練方式，', '每天盯螢幕太久，', '剛運動完回來掛機，', '先提醒還醒著的人，'
        ],
        remarks: [
            '規律一點比偶爾一次練到完全沒力更容易維持。',
            '跑步不用一開始就追速度，先讓呼吸和步頻穩下來。',
            '重訓動作做得標準，比硬加重量更值得在意。',
            '游泳看起來很輕鬆，真的下水才知道全身都在出力。',
            '羽球步伐跟反應都很吃體力，打幾局就會開始喘。',
            '網球每一拍都要提早移動，站著等球通常已經來不及。',
            '棒球比賽節奏有快有慢，投打對決的細節才是重點。',
            '運動前熱身、結束後放鬆，隔天身體的差別很明顯。',
            '睡眠和恢復也是訓練的一部分，不是只有流汗才算。',
            '坐太久起來走幾分鐘，比一直撐到腰痠有效多了。'
        ]
    },
    {
        key: 'videogames',
        leads: [
            '最近除了天堂還在玩別的遊戲，', '有人遊戲庫也越堆越多嗎？', '掛機時突然想到以前的電玩，', '最近想換個遊戲口味，', '朋友一直推薦我新遊戲，',
            '每次看到特價，', '聊到電玩我最在意，', '昨天玩單機玩到太晚，', '現在的遊戲選擇真的很多，', '先調查一下頻道玩家的喜好，'
        ],
        remarks: [
            '角色扮演最怕支線太好玩，主線放著放著就忘了。',
            '策略遊戲開局說只玩一回合，回神時常常已經天亮。',
            '動作遊戲手感順不順，玩五分鐘通常就能感覺出來。',
            '射擊遊戲反應很重要，但地圖觀念差一樣會一直迷路。',
            '獨立遊戲畫面不一定華麗，創意反而常常讓人記很久。',
            '競速遊戲差零點幾秒就想重跑，時間會被默默吃光。',
            '格鬥遊戲看高手很流暢，自己按起來完全是另一回事。',
            '生存遊戲前期什麼都缺，後期家裡卻塞滿捨不得丟的東西。',
            '隨機地城每次重來都不同，輸了還是會忍不住再開一場。',
            '多人遊戲最好玩的常常不是勝負，是語音裡那些意外場面。'
        ]
    }
];
function _wcBuildExtraChatLines() {
    let out = [], seen = new Set();
    for (let combo = 0; combo < 100 && out.length < 500; combo++) {
        for (let i = 0; i < WC_EXTRA_CHAT_TOPICS.length && out.length < 500; i++) {
            let topic = WC_EXTRA_CHAT_TOPICS[i];
            let line = topic.leads[combo % topic.leads.length] +
                topic.remarks[Math.floor(combo / topic.leads.length) % topic.remarks.length];
            if (seen.has(line)) continue;
            seen.add(line);
            out.push(line);
        }
    }
    return out;
}
const WC_EXTRA_CHAT_LINES = _wcBuildExtraChatLines();
const WC_ALL_CHAT_LINES = WC_CHAT_LINES.concat(WC_EXTRA_CHAT_LINES);

function _wcRememberChatLine(line) {
    if (!line) return '';
    _wcRecentIdleLines.push(line);
    while (_wcRecentIdleLines.length > WC_RECENT_CHAT_LIMIT) _wcRecentIdleLines.shift();
    return line;
}
function _wcPickIdleChatLine() {
    let pool = (Array.isArray(WC_ALL_CHAT_LINES) ? WC_ALL_CHAT_LINES : []).filter(Boolean);
    if (!pool.length) return '';
    let fresh = [];
    for (let i = 0; i < pool.length; i++) {
        if (_wcRecentIdleLines.indexOf(pool[i]) < 0) fresh.push(pool[i]);
    }
    return _wcRememberChatLine(_wcPick(fresh.length ? fresh : pool));
}
function _wcCanIdleChat() {
    if (typeof document === 'undefined') return false;
    let game = document.getElementById('game-screen');
    if (!game || game.classList.contains('hidden')) return false;
    if (typeof player === 'undefined' || !player || !player.cls) return false;
    if (typeof state !== 'undefined' && state && state.ff) return false;
    return typeof logWorld === 'function';
}
function _wcPostIdleChat() {
    if (!_wcCanIdleChat()) return;
    let count = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
        setTimeout(function() {
            if (!_wcCanIdleChat()) return;
            let id = _wcSpawnNpc();
            logWorld(`<span class="wc-answer wc-idle-chat">${_wcNameHtml(id)}：${_wcEsc(_wcPickIdleChatLine())}</span>`);
        }, i * (650 + Math.floor(Math.random() * 450)));
    }
}
const WC_UNKNOWN_LINES = [
    '這個我還真不知道，等其他人回你。',
    '沒研究耶，你問問看別人。',
    '這問題有點深，我只會掛機。',
    '不確定，別聽我的亂講。',
    '我查不到現行資料，先不亂報怪名。',
    '這好像改版過，舊攻略不一定能信。',
    '完整名稱打一下，我只看兩個字猜不出來。',
    '你先說一般、經典還是傳統，規則可能不同。',
    '這題要看你目前職業跟等級，資訊不夠。',
    '怪物專屬掉落表沒有寫，可能是製作或任務品。',
    '我印象中有改過，但不敢拿舊版本害你白掛。',
    '這個得看物品說明或製作 NPC，我不亂掰。',
    '頻道有人知道嗎？這題我先投降。',
    '我只知道不是你說的那個舊版來源。',
    '先去統計的掉落物頁核對，資料會比記憶可靠。',
    '我沒實測過，讓真的打到的人回答。',
    '可能有前置條件，你把任務狀態也講一下。',
    '這問題太模糊，至少給個物品或怪物全名。',
    '目前資料無法確認，亂講只會害你多掛一晚。'
];
// 人格語尾／開場（讓同一份答案有不同口氣）
const WC_TONE = {
    helpful: { open: ['', '簡單講，', '我跟你說，', '我剛好解過，', '照現在版本，'], end: ['', ' 加油。', ' 有問題再問。', ' 先照這個打就對了。', ' 記得先接任務。'] },
    veteran: { open: ['當年我們都是', '老實說，', '玩久了就知道，', '聽老玩家一句，', '這個我農過，'], end: ['', ' 就這樣。', ' 不用想太多。', ' 剩下就是耐心。', ' 天堂就是這樣。'] },
    sarcastic: { open: ['喔，', '嗯…', '這還用問？', '先別急著躺，', '看你這麼可憐，'], end: ['', ' 懂了嗎。', ' 不客氣。', ' 下次先看說明。', ' 別再白打了。'] },
    newbie: { open: ['我也不太確定啦，', '我剛玩沒多久，', '不專業建議：', '我昨天好像有解到，', '新手互助一下，'], end: [' 應該吧？', '……大概。', ' 我也還在學。', ' 你可以再核對統計。', ' 有錯別打我。'] },   // ⚠️ 開場不要用「我朋友說」這種轉述句：答案本體多為第一人稱，接起來語意會打架
    trader: { open: ['做生意的角度看，', '講白的，', '', '市場老手跟你說，', '省金幣的玩法是，'], end: ['', ' 剩下自己算。', ' 要買賣再密我。', ' 別買貴了。', ' 能打就別亂花錢。'] }
};

// ---- 問題分類 ----
function _wcMatchTopic(q) {
    let dynamic = _wcDynamicTopic(q);
    if (dynamic) return dynamic;
    let best = null, bestHit = 0;
    WC_TOPICS.forEach(t => {
        let hit = t.kw.reduce((n, k) => n + (q.indexOf(k) >= 0 ? k.length : 0), 0);
        if (hit > bestHit) { bestHit = hit; best = t; }
    });
    return best;
}

// ================= 💬 發問主流程 =================
function worldChannelAsk() {
    let input = document.getElementById('world-input');
    if (!input) return;
    let q = String(input.value || '').trim();
    if (!q) return;
    let now = Date.now();
    if (now < _wcAskCooldownUntil) {
        logWorld('<span class="wc-sys">你講太快了，讓別人也說一下話。</span>');
        return;
    }
    _wcAskCooldownUntil = now + 3000;
    input.value = '';
    let myName = (typeof player !== 'undefined' && player && player.name) ? player.name : '你';
    let myAlignment = (typeof player !== 'undefined' && player) ? player.alignmentValue : 0;
    logWorld(`<span class="wc-ask">[${_wcStaticNameHtml(myName, myAlignment)}] ${_wcEsc(q)}</span>`);

    let topic = _wcMatchTopic(q);
    let n = 1 + Math.floor(Math.random() * 3);             // 每次隨機 1~3 人回覆
    let answerCount = topic ? 1 : 0;                       // 可回答問題固定 1 人回答，其餘只閒聊或嗆聲
    let kinds = [];
    for (let i = 0; i < answerCount; i++) kinds.push('answer');
    while (kinds.length < n) kinds.push(Math.random() < 0.58 ? 'chat' : 'mock');
    for (let i = kinds.length - 1; i > 0; i--) { let j = Math.floor(Math.random() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
    for (let i = 0; i < n; i++) {
        let delay = 500 + i * (600 + Math.floor(Math.random() * 900));
        (function (kind, delay) {
            setTimeout(function () {
                try {
                    let id = _wcSpawnNpc();
                    let npc = _wcNpcs[id];
                    if (kind === 'answer') {
                        let pool = topic.gen(q) || [];
                        let core = _wcPick(pool) || _wcPick(WC_UNKNOWN_LINES);
                        let tone = WC_TONE[npc.persona] || WC_TONE.helpful;
                        logWorld(`<span class="wc-answer">${_wcNameHtml(id)}：${_wcEsc(_wcPick(tone.open) + core + _wcPick(tone.end))}</span>`);
                    } else if (kind === 'chat') {
                        logWorld(`<span class="wc-answer">${_wcNameHtml(id)}：${_wcEsc(_wcPickIdleChatLine())}</span>`);
                    } else {
                        logWorld(`<span class="wc-mock">${_wcNameHtml(id)}：${_wcEsc(_wcPick(WC_MOCK_LINES))}</span>`);
                    }
                } catch (e) {}
            }, delay);
        })(kinds[i], delay);
    }
}

// ================= 👆 NPC 名字點擊：嘲諷／感謝 =================
function worldChannelNpcMenu(id, ev) {
    if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
    }
    let npc = _wcNpcs[id];
    let old = document.getElementById('world-channel-npc-menu');
    let wasSame = !!old && old.dataset.npc === id;
    worldChannelCloseMenu();
    if (wasSame) return;
    if (!npc) { logWorld('<span class="wc-sys">這個人已經下線了。</span>'); return; }

    _wcMenuOpenId = id;
    let menu = document.createElement('div');
    menu.id = 'world-channel-npc-menu';
    menu.className = 'wandering-shout-menu';
    menu.dataset.npc = id;
    menu.innerHTML =
        `<button type="button" class="wandering-taunt-entry" onclick="worldChannelTaunt('${id}')">嘲諷</button>` +
        `<button type="button" onclick="worldChannelThank('${id}')">感謝</button>` +
        `<button type="button" onclick="worldChannelCloseMenu()">算了</button>`;
    document.body.appendChild(menu);

    let x = ev && Number.isFinite(ev.clientX) ? ev.clientX : Math.round(window.innerWidth / 2);
    let y = ev && Number.isFinite(ev.clientY) ? ev.clientY : Math.round(window.innerHeight / 2);
    let rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y + 8, window.innerHeight - rect.height - 8)) + 'px';

    setTimeout(function() {
        if (_wcMenuOpenId !== id || !document.body.contains(menu)) return;
        _wcMenuDocHandler = function(e) {
            if (!menu.contains(e.target)) worldChannelCloseMenu();
        };
        document.addEventListener('click', _wcMenuDocHandler);
    }, 0);
}
function worldChannelCloseMenu() {
    let m = document.getElementById('world-channel-npc-menu');
    if (m) m.remove();
    let legacy = document.querySelector('.wc-menu');
    if (legacy) legacy.remove();
    if (_wcMenuDocHandler) {
        document.removeEventListener('click', _wcMenuDocHandler);
        _wcMenuDocHandler = null;
    }
    _wcMenuOpenId = null;
}

const WC_TAUNT_OUT = ['你這種等級也敢教人？', '講得好像你很懂一樣。', '嘴巴閉上會比較有幫助。', '你回的這什麼廢話。', '沒料就不要出來丟臉。'];
const WC_TAUNT_BACK = {
    helpful: ['好心被雷親，那你自己查吧。', '算了，我不該回你的。', '下次不會再回答你了。'],
    veteran: ['小朋友，等你練到我這等級再說。', '我玩的時候你還在新兵村。', '嘴很硬喔，城外見。'],
    sarcastic: ['哈，被說中了才生氣？', '你這反應也太好猜了。', '繼續氣，我看戲。'],
    newbie: ['對不起啦……我只是想幫忙。', '嗚，我不說話了。', '你兇什麼啦。'],
    trader: ['嘴砲不能換金幣，兄弟。', '有本事拿貨出來說話。', '不買不賣就別佔頻道。']
};
const WC_THANK_OUT = ['感謝大大，受教了。', '謝啦，這下清楚多了。', '太感謝了，我去試試。', '感恩，之前一直卡在這。'];
const WC_THANK_BACK = {
    helpful: ['不會啦，互相幫忙。', '客氣了，有問題再問。', '祝你順利。'],
    veteran: ['嗯，記得就好。', '不用謝，當年也有人這樣教我。', '別死太多次就行。'],
    sarcastic: ['算你識相。', '難得有人會道謝，收下了。', '嗯哼，不客氣。'],
    newbie: ['欸？我說對了嗎？太好了！', '不…不用謝我啦。', '我也是聽來的而已。'],
    trader: ['免費的建議就這樣，要裝備再找我。', '不客氣，記得來光顧。', '好說。']
};

function worldChannelTaunt(id) {
    let npc = _wcNpcs[id];
    worldChannelCloseMenu();
    if (!npc) { logWorld('<span class="wc-sys">這個人已經下線了。</span>'); return; }
    if (npc.blocked) { _wcBlockedNotice(); return; }
    let nameHtml = _wcStaticNameHtml(npc.name, npc.alignmentValue);
    logWorld(`<span class="wander-chat-out"><span class="wander-chat-arrow">-&gt;</span> <span class="wander-chat-target">[${nameHtml}]</span> ${_wcEsc(_wcPick(WC_TAUNT_OUT))}</span>`);
    let back = WC_TAUNT_BACK[npc.persona] || WC_TAUNT_BACK.helpful;
    logWorld(`<span class="wander-chat-in"><span class="wander-chat-speaker">[${nameHtml}]</span> ${_wcEsc(_wcPick(back))}</span>`);
    npc.taunted = true;
    if (Math.random() < _wcTauntChaseChance(npc)) {
        _wcAddGrudge(npc);
        _wcRemoveNpcMessages(id);
        delete _wcNpcs[id];
    } else if (Math.random() < 0.2) {
        npc.blocked = true;
        _wcBlockedNotice();
    }
}
function worldChannelThank(id) {
    let npc = _wcNpcs[id];
    worldChannelCloseMenu();
    if (!npc) { logWorld('<span class="wc-sys">這個人已經下線了。</span>'); return; }
    if (npc.blocked) { _wcBlockedNotice(); return; }
    let nameHtml = _wcStaticNameHtml(npc.name, npc.alignmentValue);
    if (npc.thanked) { logWorld(`<span class="wc-sys">你已經謝過 ${nameHtml} 了。</span>`); return; }
    npc.thanked = true;
    logWorld(`<span class="wander-chat-out"><span class="wander-chat-arrow">-&gt;</span> <span class="wander-chat-target">[${nameHtml}]</span> ${_wcEsc(_wcPick(WC_THANK_OUT))}</span>`);
    let back = WC_THANK_BACK[npc.persona] || WC_THANK_BACK.helpful;
    logWorld(`<span class="wander-chat-in"><span class="wander-chat-speaker">[${nameHtml}]</span> ${_wcEsc(_wcPick(back))}</span>`);
    // 被感謝的世界頻道 NPC 若原本記仇 → 消氣；只移除本系統建立的追殺，避免誤刪同名拍賣/PVP NPC。
    try {
        if (Array.isArray(player.trollPlayers)) {
            let removed = false;
            player.trollPlayers = player.trollPlayers.filter(t => {
                let isWorldGrudge = t && t.n === npc.name && (t.source === 'worldChannel' || t.wcGrudge);
                if (isWorldGrudge) removed = true;
                return !isWorldGrudge;
            });
            if (!removed) return;
            logWorld(`<span class="wc-sys">${nameHtml} 好像沒那麼氣了。</span>`);
            if (typeof saveGame === 'function') saveGame();
        }
    } catch (e) {}
}
// 記仇：寫進白目玩家名單（結構比照 js/24 _startWandererChase：n／avatar／alignmentValue／until）
function _wcAddGrudge(npc) {
    try {
        if (typeof player === 'undefined' || !player || !player.cls) return;
        if (!Array.isArray(player.trollPlayers)) player.trollPlayers = [];
        if (player.trollPlayers.some(t => t && t.n === npc.name)) return;
        let male = Math.random() < 0.5;
        let avatarByCls = { royal: male ? '王子' : '公主', knight: male ? '男騎士' : '女騎士', mage: male ? '男法師' : '女法師',
            elf: male ? '男妖精' : '女妖精', dark: male ? '男黑暗妖精' : '女黑暗妖精', dragon: male ? '男龍騎士' : '女龍騎士',
            warrior: male ? '男戰士' : '女戰士', illusion: male ? '男幻術士' : '女幻術士' };
        player.trollPlayers.push({
            n: npc.name,
            avatar: avatarByCls[npc.cls] || (male ? '男戰士' : '女戰士'),
            source: 'worldChannel',
            wcGrudge: true,
            alignmentValue: _wcAlignmentValue(npc.alignmentValue),
            until: Date.now() + 2 * 60 * 60 * 1000
        });
        logWorld(`<span class="text-rose-400 font-bold">[${_wcStaticNameHtml(npc.name, npc.alignmentValue)}] 惡狠狠地記住了你……</span>`);
        if (typeof saveGame === 'function') saveGame();
    } catch (e) {}
}

// ---- 輸入列：Enter 送出（⚠️ 中文注音組字中的 Enter 是「選字」，必須用 isComposing 擋掉，否則打不出中文）----
(function initWorldInput() {
    function bind() {
        let el = document.getElementById('world-input');
        if (!el) return;
        if (!el._wcBound) {
            el._wcBound = true;
            let composing = false;
            el.addEventListener('compositionstart', function () { composing = true; });
            el.addEventListener('compositionend', function () { composing = false; });
            el.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                if (composing || e.isComposing || e.keyCode === 229) return;   // 組字中：交給輸入法選字
                e.preventDefault();
                worldChannelAsk();
            });
        }
        if (typeof initWorldLogLock === 'function') initWorldLogLock();
        if (!_wcIdleTimer) _wcIdleTimer = setInterval(_wcPostIdleChat, 60 * 1000);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
