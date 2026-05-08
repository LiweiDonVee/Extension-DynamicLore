// DynamicLore — automatically update World Info from chat
// Fixed version — uses SillyTavern.getContext() directly, no webpack needed

const DL = (function () {
    const NAME = 'dynamicLore';

    function ctx() { return SillyTavern.getContext(); }
    function ext() { return ctx().extensionSettings[NAME]; }

    // ── init ──────────────────────────────────────────────────────────
    function init() {
        const s = ctx().extensionSettings;
        if (!s[NAME]) {
            s[NAME] = {
                enabled: true,
                auto_analyze: true,
                analysis_interval: 5,
                auto_approve: false,
                message_count: 0,
                target_wi_book: '',   // '' = currently selected global WI
            };
        }

        registerSlash();
        buildUI();
        if (ext().auto_analyze) listenMessages();
    }

    // ── slash command ─────────────────────────────────────────────────
    function registerSlash() {
        ctx().registerSlashCommand('dynamiclore', async (_namedArgs, unnamedArgs) => {
            const args = String(unnamedArgs || '').trim().split(/\s+/).filter(Boolean);
            if (args[0] === 'analyze') { await analyzeCurrentChat(); return ''; }
            if (args[0] === 'interval' && args[1]) {
                ext().analysis_interval = Math.max(1, parseInt(args[1]) || 5);
                ext().message_count = 0;
                ctx().saveSettingsDebounced();
                return `DynamicLore interval → ${ext().analysis_interval} msgs`;
            }
            if (args[0] === 'book' && args[1]) {
                ext().target_wi_book = args[1] === 'auto' ? '' : args[1];
                ctx().saveSettingsDebounced();
                return `Target WI book: ${ext().target_wi_book || '<auto>'}`;
            }
            togglePanel();
            return '';
        });
    }

    // ── message listeners ─────────────────────────────────────────────
    function listenMessages() {
        const c = ctx();
        c.eventSource.on(c.event_types.CHARACTER_MESSAGE_RENDERED, onMessage);
    }

    function onMessage(_msgId, _source) {
        ext().message_count = (ext().message_count || 0) + 1;
        if (ext().message_count >= ext().analysis_interval) {
            ext().message_count = 0;
            analyzeCurrentChat();
        }
        ctx().saveSettingsDebounced();
    }

    // ── core analysis ─────────────────────────────────────────────────
    async function analyzeCurrentChat() {
        const chat = ctx().chat;
        if (!chat || chat.length < 2) return;

        // last N messages
        const recent = chat.slice(-10);
        const text = recent.map(m =>
            `${m.is_user ? '{{user}}' : '{{char}}'}: ${String(m.mes).replace(/<[^>]+>/g, '')}`
        ).join('\n');

        // include existing WI entries for context
        const currentWI = getCurrentWIData();
        const existingSummary = buildExistingSummary(currentWI);

        const sys = `You are a World Info (lorebook) curator for a SillyTavern roleplay. Your job is to extract structured knowledge from a conversation and return it as JSON for World Info entries.

World Info rules:
- Content is the ONLY field sent to the AI model. Keywords/title are NOT sent.
- Each entry must be SELF-CONTAINED — do not reference other entries.
- Keep entries concise (50-100 tokens each).
- Use Chinese AND English keywords for bilingual coverage.
- Mark `isUpdate: true` + `targetUid` ONLY if updating an EXISTING entry.
- New entries should NOT have targetUid.

Keyword rules (IMPORTANT):
- Keywords MUST be specific to THIS entry — do NOT include parent/container names.
- Example: for "镜厅" (a room in Beauxbatons), use ["镜厅","Hall of Mirrors","封印大厅"] — do NOT include "布斯巴顿" or "Beauxbatons" as keywords.
- Example: for a character, use their personal name variants, NOT the school/organization they belong to.

Output ONLY valid JSON — no markdown, no explanation:`;

        const user = `## CURRENT WORLD INFO ENTRIES
${existingSummary || '(No entries yet — all knowledge is new)'}

## RECENT CONVERSATION
${text}

Analyze this conversation and extract World Info entries. Focus on:
1. Important characters (names, descriptions, relationships)
2. Locations (places mentioned)
3. Objects, items, technology
4. Rules of the world, systems, organizations
5. Recent events worth remembering

For each piece of knowledge, decide:
- Is it NEW (no matching existing entry)? → create a new entry
- Does it UPDATE an existing entry? → set isUpdate:true + targetUid

Output JSON:
{
  "entries": [
    {
      "isUpdate": false,
      "targetUid": null,
      "name": "Brief entry title",
      "content": "Self-contained description (50-100 tokens)",
      "keywords": ["key1", "key2", "关键词1"],
      "type": "character|location|object|rule|event",
      "confidence": 0.85,
      "reason": "Why this needs a WI entry"
    }
  ]
}`;

        try {
            const raw = await ctx().generateRaw({
                prompt: user,
                systemPrompt: sys,
                responseLength: 2048,
            });

            const json = extractJSON(raw);
            if (!json || !json.entries || json.entries.length === 0) {
                console.log('[DynamicLore] No entries extracted from analysis');
                return;
            }

            const results = processEntries(json.entries, currentWI);
            showResults(results);

        } catch (e) {
            console.error('[DynamicLore] Analysis failed:', e);
            toastr.warning('DynamicLore: Analysis failed. Check console.');
        }
    }

    // ── JSON extraction ───────────────────────────────────────────────
    function extractJSON(raw) {
        if (!raw) return null;
        // Remove reasoning/thinking content if present
        let text = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '');
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1) return null;
        try {
            return JSON.parse(text.slice(start, end + 1));
        } catch (e) {
            console.error('[DynamicLore] JSON parse error:', e, 'text:', text.slice(0, 200));
            return null;
        }
    }

    // ── process entries (match against existing WI) ───────────────────
    function processEntries(entries, currentWI) {
        const results = { news: [], updates: [] };
        for (const e of entries) {
            if (e.isUpdate && e.targetUid != null) {
                const existing = findEntryByUid(currentWI, e.targetUid);
                if (existing) {
                    results.updates.push({
                        uid: e.targetUid,
                        name: e.name,
                        oldContent: existing.content || '',
                        oldKeys: (existing.key || []).join(', '),
                        newContent: e.content,
                        newKeys: (e.keywords || []).join(', '),
                        mergedContent: existing.content
                            ? existing.content + '\n\n' + e.content
                            : e.content,
                        type: e.type,
                        confidence: e.confidence || 0.7,
                        reason: e.reason || '',
                    });
                    continue;
                }
            }
            // Try to find match by name/keyword
            const match = findMatchingEntry(currentWI, e);
            if (match) {
                results.updates.push({
                    uid: match.uid,
                    name: e.name || match.comment,
                    oldContent: match.content || '',
                    oldKeys: (match.key || []).join(', '),
                    newContent: e.content,
                    newKeys: mergeKeys(match.key || [], e.keywords || []).join(', '),
                    mergedContent: (match.content || '') + '\n\n' + e.content,
                    type: e.type,
                    confidence: e.confidence || 0.7,
                    reason: e.reason || '',
                });
            } else {
                results.news.push({
                    name: e.name,
                    content: e.content,
                    keywords: e.keywords || [],
                    type: e.type,
                    confidence: e.confidence || 0.7,
                    reason: e.reason || '',
                });
            }
        }
        return results;
    }

    function findEntryByUid(wi, uid) {
        if (!wi || !wi.entries) return null;
        return Object.values(wi.entries).find(e => e.uid === uid) || null;
    }

    function findMatchingEntry(wi, entry) {
        if (!wi || !wi.entries) return null;
        const entries = Object.values(wi.entries);
        const newKeys = (entry.keywords || []).map(k => k.toLowerCase());
        if (newKeys.length === 0) return null;

        let bestMatch = null;
        let bestScore = 0;

        for (const e of entries) {
            const ekeys = Array.isArray(e.key)
                ? e.key.map(k => k.toLowerCase())
                : String(e.key || '').split(',').map(k => k.trim().toLowerCase());

            // Score: count matching keywords
            const matchingKeys = newKeys.filter(nk => ekeys.includes(nk));
            const score = matchingKeys.length;

            // Require at least 2 keyword matches for high confidence, or
            // if only 1 match, require it to be a "name-level" keyword (e.g. character name)
            if (score > bestScore) {
                bestScore = score;
                bestMatch = e;
            }
        }

        // Require at least 2 matching keywords, or 1 + name-in-content match
        if (bestScore >= 2) return bestMatch;

        // Single keyword match: only accept if entry name also appears in content
        if (bestScore === 1 && entry.name) {
            const content = String(bestMatch.content || '').toLowerCase();
            const firstLine = content.split('\n')[0];
            if (firstLine.includes(entry.name.toLowerCase())) return bestMatch;
        }

        // No keyword match: try name-only match in content
        if (bestScore === 0 && entry.name) {
            const match = entries.find(e => {
                const content = String(e.content || '').toLowerCase();
                const firstLine = content.split('\n')[0];
                return firstLine.includes(entry.name.toLowerCase());
            });
            if (match) return match;
        }

        return null;
    }

    function mergeKeys(existing, adding) {
        const set = new Set((Array.isArray(existing) ? existing : String(existing).split(',').map(k => k.trim())).filter(Boolean));
        for (const k of adding) set.add(k.trim());
        return [...set];
    }

    // ── get current WI data ───────────────────────────────────────────
    function getCurrentWIData() {
        const c = ctx();
        const target = ext().target_wi_book;
        if (target && c.worldInfo && c.worldInfo[target]) {
            return c.worldInfo[target];
        }
        // use currently selected global WI
        const names = c.getWorldInfoNames ? c.getWorldInfoNames() : [];
        // Find the book whose entries are currently loaded
        if (c.worldInfo) {
            for (const [name, data] of Object.entries(c.worldInfo)) {
                if (data && data.entries && Object.keys(data.entries).length > 0) {
                    return data;
                }
            }
        }
        return null;
    }

    function buildExistingSummary(wi) {
        if (!wi || !wi.entries) return '';
        const lines = [];
        for (const e of Object.values(wi.entries)) {
            if (!e || e.constant) continue; // skip constants
            const keys = Array.isArray(e.key) ? e.key.join(', ') : (e.key || '');
            const content = String(e.content || '').slice(0, 200);
            lines.push(`[${e.uid}] ${e.comment || '(no name)'} | Keys: ${keys}\n  Content: ${content.replace(/\n/g, ' ')}`);
        }
        return lines.join('\n');
    }

    // ── apply entry ───────────────────────────────────────────────────
    function applyEntry(result) {
        const c = ctx();
        const bookName = ext().target_wi_book || getCurrentBookName();
        if (!bookName) {
            toastr.error('No target World Info book selected');
            return;
        }
        const wi = getCurrentWIData();
        if (!wi || !wi.entries) {
            // create new book
            c.worldInfo[bookName] = { entries: {}, originalData: {} };
        }

        const data = getCurrentWIData() || c.worldInfo[bookName];

        if (result.uid != null) {
            // update existing
            const e = findEntryByUid(data, result.uid);
            if (e) {
                e.content = result.mergedContent || result.newContent;
                e.key = result.newKeys ? result.newKeys.split(',').map(k => k.trim()).filter(Boolean) : e.key;
                if (result.name) e.comment = result.name;
            }
        } else {
            // create new
            const uid = getMaxUid(data) + 1;
            data.entries[uid] = {
                uid: uid,
                key: result.keywords || [],
                keysecondary: [],
                comment: result.name || 'DynamicLore entry',
                content: result.content,
                constant: false,
                selective: false,
                vectorized: false,
                disable: false,
                order: 300,
                position: 1, // after char
                depth: null,
                role: 0,
                selectiveLogic: 0,
                group: '',
                probability: null,
                useProbability: false,
                automationId: '',
            };
        }

        // save
        c.saveWorldInfo(bookName, data, true).then(() => {
            console.log('[DynamicLore] Saved WI book:', bookName);
            if (c.reloadWorldInfoEditor) c.reloadWorldInfoEditor();
        }).catch(e => {
            console.error('[DynamicLore] Save failed:', e);
        });
    }

    function getMaxUid(data) {
        if (!data || !data.entries) return 0;
        return Math.max(0, ...Object.keys(data.entries).map(Number).filter(n => !isNaN(n)));
    }

    function getCurrentBookName() {
        const c = ctx();
        const names = c.getWorldInfoNames ? c.getWorldInfoNames() : [];
        // find loaded book
        if (c.worldInfo) {
            for (const [name, data] of Object.entries(c.worldInfo)) {
                if (data && data.entries && Object.keys(data.entries).length > 0) {
                    return name;
                }
            }
        }
        return names[0] || 'DynamicLore';
    }

    // ── UI ────────────────────────────────────────────────────────────
    let panel = null;

    function buildUI() {
        const body = document.body;

        // Panel
        panel = document.createElement('div');
        panel.id = 'dynamiclore_panel';
        panel.className = 'drawer drawer--wide';
        panel.style.cssText = 'display:none;';
        panel.innerHTML = `
            <div class="drawer-header">
                <span class="drawer-icon fa-solid fa-book-open fa-fw"></span>
                <span class="drawer-title">DynamicLore</span>
                <div class="drawer-close fa-solid fa-xmark" id="dl_close"></div>
            </div>
            <div class="drawer-content" style="padding:1em;">
                <div style="display:flex;gap:8px;margin-bottom:12px;">
                    <button id="dl_analyze" class="menu_button">Analyze Chat Now</button>
                    <label style="display:flex;align-items:center;gap:4px;font-size:0.9em;margin-left:12px;">
                        <input type="checkbox" id="dl_auto" ${ext().auto_analyze ? 'checked' : ''}> Auto
                    </label>
                    <span style="font-size:0.8em;opacity:0.6;align-self:center;">Every</span>
                    <input type="number" id="dl_interval" value="${ext().analysis_interval}" min="1" max="50" style="width:50px;">
                    <span style="font-size:0.8em;opacity:0.6;align-self:center;">msgs</span>
                </div>
                <div id="dl_results"></div>
            </div>`;
        body.appendChild(panel);

        // Event bindings
        document.getElementById('dl_close').onclick = () => panel.style.display = 'none';
        document.getElementById('dl_analyze').onclick = () => analyzeCurrentChat();
        document.getElementById('dl_auto').onchange = function() {
            ext().auto_analyze = this.checked;
            ctx().saveSettingsDebounced();
        };
        document.getElementById('dl_interval').onchange = function() {
            ext().analysis_interval = Math.max(1, parseInt(this.value) || 5);
            ext().message_count = 0;
            ctx().saveSettingsDebounced();
        };

        // Add menu button in extensions panel
        const extensionsMenu = document.getElementById('extensionsMenu');
        if (extensionsMenu) {
            const btn = document.createElement('div');
            btn.id = 'dl_menu_btn';
            btn.className = 'list-group-item';
            btn.innerHTML = '<i class="fa-solid fa-book-open fa-fw"></i> DynamicLore';
            btn.onclick = togglePanel;
            extensionsMenu.appendChild(btn);
        }
    }

    function togglePanel() {
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? '' : 'none';
    }

    function showResults(results) {
        const container = document.getElementById('dl_results');
        if (!container) return;

        const { news, updates } = results;
        container.innerHTML = '';

        const h3 = document.createElement('h4');
        h3.textContent = `Found ${news.length} new + ${updates.length} updates`;
        container.appendChild(h3);

        for (const r of news) {
            container.appendChild(buildCard('🆕 New Entry', r, false));
        }
        for (const r of updates) {
            container.appendChild(buildCard('✏️ Update', r, true));
        }

        if (news.length === 0 && updates.length === 0) {
            container.innerHTML += '<p style="opacity:0.6;">No entries to propose.</p>';
        }
    }

    function buildCard(title, r, isUpdate) {
        const div = document.createElement('div');
        div.style.cssText = 'border:1px solid #444;border-radius:8px;padding:10px;margin:8px 0;background:#1a1a2e;';
        const conf = Math.round((r.confidence || 0.7) * 100);
        div.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <strong>${title}</strong>
                <span style="font-size:0.8em;opacity:0.7;">${r.type || ''} · ${conf}% confidence</span>
            </div>
            <div><strong>${r.name}</strong></div>
            ${isUpdate ? `<div style="margin-top:4px;font-size:0.8em;opacity:0.7;">Old: <span style="white-space:pre-wrap;">${r.oldContent.slice(0, 100)}...</span></div>` : ''}
            <div style="margin-top:4px;white-space:pre-wrap;font-size:0.9em;">${r.newContent || r.content}</div>
            <div style="margin-top:4px;font-size:0.8em;opacity:0.7;">Keys: ${r.newKeys || (r.keywords||[]).join(', ')}</div>
            ${r.reason ? `<div style="font-size:0.8em;opacity:0.5;margin-top:2px;">Reason: ${r.reason}</div>` : ''}
            <div style="margin-top:8px;display:flex;gap:6px;">
                <button class="menu_button dl_accept">Accept</button>
                <button class="menu_button menu_button_default dl_reject">Reject</button>
            </div>`;

        div.querySelector('.dl_accept').onclick = () => {
            applyEntry(r);
            div.style.opacity = '0.5';
            div.querySelector('.dl_accept').disabled = true;
            div.querySelector('.dl_reject').disabled = true;
        };
        div.querySelector('.dl_reject').onclick = () => div.remove();

        return div;
    }

    // ── auto-approve for high confidence ──────────────────────────────
    // (if enabled in settings, entries with confidence > 0.8 auto-accept)

    // ── bootstrap ────────────────────────────────────────────────────
    jQuery(() => {
        if (document.readyState === 'complete') {
            init();
        } else {
            window.addEventListener('load', init);
        }
    });

    return { init, analyzeCurrentChat, togglePanel };
})();
