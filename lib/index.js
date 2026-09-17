/**
 * dsh-memorix-panel — host half.
 *
 * Serves the panel's JSON API under `/memorix-panel/api` and owns every
 * filesystem/CLI touch:
 *
 *   - READ: the local Memorix store (`<memorix home>/data/memorix.db`, one
 *     SQLite database holding every project, discriminated by `projectId`).
 *     Implemented with `node:sqlite` (Node >= 22.5) and, when that module is
 *     unavailable, falling back to `python3` (stdlib `sqlite3`). No runtime
 *     dependency of this package is involved.
 *   - WRITE: never SQL. Status changes and new memories go through the
 *     official `memorix` CLI (`memory resolve` / `memory store`) so Memorix's
 *     own search index, topic-key upsert and audit trail stay in sync.
 *
 * Every route is fenced to same-origin browser traffic from a loopback or
 * deployment-trusted authority (mirrors the shipped `/api` gateway fence).
 *
 * @module dsh-memorix-panel
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** Stable Cordis plugin name (matches the row id in cordis.patch.yml). */
export const name = 'memorix-panel'

/** The HTTP carrier must be mounted before the routes can register. */
export const inject = ['webServer']

const execFileAsync = promisify(execFile)

const ROUTE_PREFIX = '/memorix-panel/api'

/** Observation statuses accepted by `memorix memory resolve`. */
const STATUSES = ['active', 'resolved', 'archived']

/** Observation types accepted by `memorix memory store`. */
const TYPES = [
  'session-request', 'gotcha', 'problem-solution', 'how-it-works', 'what-changed',
  'discovery', 'why-it-exists', 'decision', 'trade-off', 'reasoning', 'probe',
]

const LIMITS = { title: 200, text: 20000, entity: 120, topicKey: 200, listItems: 40, listItem: 500 }

/** Table name → totals key, for the optional counters in the status card. */
const COUNT_TABLES = [
  ['longTerm', 'long_term_memories'],
  ['miniSkills', 'mini_skills'],
  ['sessions', 'sessions'],
  ['evidenceCards', 'evidence_cards'],
  ['knowledgePages', 'knowledge_pages'],
  ['mediaAssets', 'media_assets'],
  ['codeFiles', 'code_files'],
]

/** The three tables behind the durable (long-term) memory layer. */
const LONG_TERM_TABLES = ['long_term_memories', 'long_term_memory_evidence', 'long_term_memory_events']

/** Display order for long-term states: live first, retired last. */
const LONG_TERM_STATE_ORDER = ['approved', 'qualified', 'candidate', 'archived', 'superseded']

/** Long-term lifecycle transitions the panel may request. */
const LONG_TERM_ACTIONS = ['qualify', 'approve', 'archive']

/**
 * Resolve the effective config for one mounted row.
 * @param config - the row's `config:` block from cordis.patch.yml.
 * @returns resolved values with defaults applied.
 */
function resolveConfig(config) {
  const raw = config ?? {}
  const home = process.env.MEMORIX_HOME ?? join(homedir(), '.memorix')
  const timeout = Number(raw.cliTimeoutMs)
  return {
    bin: typeof raw.bin === 'string' && raw.bin !== '' ? raw.bin : 'memorix',
    dbPath: typeof raw.dbPath === 'string' && raw.dbPath !== '' ? raw.dbPath : join(home, 'data', 'memorix.db'),
    home,
    cliTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 25000,
    allowWrite: raw.allowWrite !== false,
    allowStore: raw.allowStore !== false,
  }
}

// ── store reads ────────────────────────────────────────────────────────────

/**
 * Read the whole store snapshot (every project) with `node:sqlite`.
 * @param dbPath - absolute path of the Memorix SQLite database.
 * @returns raw snapshot consumed by {@link buildOverview}.
 */
async function readViaNodeSqlite(dbPath) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const all = (sql, args = []) => {
      try {
        return db.prepare(sql).all(...args)
      } catch {
        return []
      }
    }
    const projects = []
    const grouped = all(
      "SELECT projectId, COUNT(*) AS total, SUM(status='active') AS active, SUM(status='archived') AS archived, " +
      "SUM(status='resolved') AS resolved, MAX(createdAt) AS lastAt, MIN(createdAt) AS firstAt " +
      'FROM observations GROUP BY projectId ORDER BY COUNT(*) DESC',
    )
    for (const group of grouped) {
      const pid = group.projectId
      const types = all(
        'SELECT type, COUNT(*) AS count FROM observations WHERE projectId=? GROUP BY type ORDER BY COUNT(*) DESC',
        [pid],
      )
      const memories = all(
        'SELECT id,title,type,status,createdAt,entityName,valueCategory FROM observations ' +
        'WHERE projectId=? ORDER BY createdAt DESC LIMIT 400',
        [pid],
      ).map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        status: row.status,
        createdAt: row.createdAt,
        entity: row.entityName ?? '',
        valueCategory: row.valueCategory ?? '',
      }))
      projects.push({
        id: pid,
        total: group.total ?? 0,
        active: group.active ?? 0,
        archived: group.archived ?? 0,
        resolved: group.resolved ?? 0,
        firstAt: group.firstAt ?? '',
        lastAt: group.lastAt ?? '',
        types: types.map((row) => ({ type: row.type, count: row.count })),
        memories,
      })
    }
    const totals = {}
    for (const [key, table] of COUNT_TABLES) {
      const row = all('SELECT COUNT(*) AS n FROM ' + table)[0]
      totals[key] = row?.n ?? 0
    }
    return { projects, totals }
  } finally {
    db.close()
  }
}

/**
 * Fallback snapshot reader for hosts without `node:sqlite` (Node < 22.5).
 * The embedded script is read-only and prints the same raw snapshot shape.
 * @param dbPath - absolute path of the Memorix SQLite database.
 * @returns raw snapshot consumed by {@link buildOverview}.
 */
async function readViaPython(dbPath) {
  const script = [
    'import sqlite3, json, sys',
    'db_path = sys.argv[1]',
    "con = sqlite3.connect('file:' + db_path + '?mode=ro', uri=True)",
    'def rows(sql, args=()):',
    '    try: return con.execute(sql, args).fetchall()',
    '    except Exception: return []',
    "out = {'projects': [], 'totals': {}}",
    'for pid, total, active, archived, resolved, last, first in rows(',
    '    "SELECT projectId, COUNT(*), SUM(status=\'active\'), SUM(status=\'archived\'), "',
    '    "SUM(status=\'resolved\'), MAX(createdAt), MIN(createdAt) FROM observations "',
    '    "GROUP BY projectId ORDER BY COUNT(*) DESC"):',
    '    types = [{"type": t, "count": n} for t, n in rows(',
    '        "SELECT type, COUNT(*) FROM observations WHERE projectId=? GROUP BY type ORDER BY COUNT(*) DESC", (pid,))]',
    '    mems = [{"id": i, "title": ti, "type": ty, "status": st, "createdAt": ca, "entity": en or "", "valueCategory": vc or ""}',
    '            for i, ti, ty, st, ca, en, vc in rows(',
    '        "SELECT id,title,type,status,createdAt,entityName,valueCategory FROM observations "',
    '        "WHERE projectId=? ORDER BY createdAt DESC LIMIT 400", (pid,))]',
    '    out["projects"].append({"id": pid, "total": total, "active": active or 0, "archived": archived or 0,',
    '                            "resolved": resolved or 0, "firstAt": first or "", "lastAt": last or "",',
    '                            "types": types, "memories": mems})',
    'for key, table in ' + JSON.stringify(COUNT_TABLES) + ':',
    '    r = rows("SELECT COUNT(*) FROM " + table)',
    '    out["totals"][key] = r[0][0] if r and r[0][0] is not None else 0',
    'print(json.dumps(out, ensure_ascii=False))',
  ].join('\n')
  const { stdout } = await execFileAsync('python3', ['-', dbPath], {
    input: script,
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/**
 * Read the store snapshot through the first backend that works.
 * @param config - resolved plugin config.
 * @returns `{ snapshot, backend }`; throws when no backend can read the file.
 */
async function readSnapshot(config) {
  try {
    return { snapshot: await readViaNodeSqlite(config.dbPath), backend: 'node:sqlite' }
  } catch (sqliteError) {
    try {
      return { snapshot: await readViaPython(config.dbPath), backend: 'python3' }
    } catch (pythonError) {
      const detail = 'node:sqlite: ' + describe(sqliteError) + ' | python3: ' + describe(pythonError)
      const error = new Error(HOST_TEXT['read.storeUnavailable'])
      error.code = 'read.storeUnavailable'
      error.detail = detail
      throw error
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** One-line message of an unknown thrown value. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Stable diagnostic codes with their Simplified-Chinese fallback text. The
 * browser localizes `code` through its own dictionaries and only falls back to
 * `error` when it does not know the code, so the host stays locale-agnostic.
 */
const HOST_TEXT = {
  'read.storeUnavailable': '无法读取 Memorix 存储(需要 Node >= 22.5 或 python3)',
  'read.longTermUnavailable': '无法读取长期记忆(需要 Node >= 22.5 或 python3)',
  'lt.writeDisabled': '该部署已禁用写入(allowWrite: false)',
  'lt.invalidId': '无效的长期记忆 id',
  'lt.invalidAction': '无效的动作(仅允许 qualify / approve / archive)',
  'lt.projectRootMissing': '未找到项目根路径',
  'lt.actionFailed': '长期记忆操作失败',
  'lt.noStateFromCli': 'CLI 未返回长期记忆状态',
  'memory.notFound': '未找到编号 #{id} 的记忆',
  'memory.invalidId': '无效的记忆编号',
  'write.statusDisabled': '该部署已禁用状态写入(allowWrite: false)',
  'write.invalidStatus': '无效的状态(仅允许 active / resolved / archived)',
  'write.projectRootMissing': '未找到该记忆所属项目的根路径',
  'write.failed': '写入 Memorix 失败',
  'write.notUpdated': 'CLI 未更新该记忆',
  'store.disabled': '该部署已禁用新建记忆(allowStore: false)',
  'store.emptyTitle': '标题不能为空',
  'store.emptyBody': '正文不能为空',
  'store.projectRootMissing': '未找到写入目标项目的根路径',
  'store.noMemoryFromCli': 'CLI 未返回新建的记忆',
  'request.badBody': '请求体解析失败',
  'request.unknownAction': '未知操作: {action}',
  'hint.noProjectMapping': '缺少 .project-aliases.json 与 last-project-root',
  'hint.noLastProjectRoot': '缺少 last-project-root',
  'hint.projectNotRegistered': '项目 {projectId} 不在 .project-aliases.json 中',
  'hint.cliProject': '项目: {root}',
}

/** Fill `{name}` placeholders from one params object. */
function fill(template, params) {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

/** Build one error body: a stable code plus a readable fallback message. */
function fail(code, extra) {
  const params = extra?.params
  const hintCode = extra?.hintCode
  const message = fill(HOST_TEXT[code] ?? code, params)
  const hint = hintCode === undefined ? '' : fill(HOST_TEXT[hintCode] ?? '', extra?.hintParams)
  const body = { ok: false, code, error: hint === '' ? message : message + '\n' + hint }
  if (params !== undefined) body.params = params
  if (hintCode !== undefined) body.hintCode = hintCode
  if (extra?.hintParams !== undefined) body.hintParams = extra.hintParams
  if (extra?.detail !== undefined) body.detail = extra.detail
  return body
}

// Relative ages are rendered by the browser half (see `ageLabel`), which knows
// the active locale; the host ships ISO timestamps only.

/** Clamp one incoming string field. */
function clampText(value, max) {
  const text = typeof value === 'string' ? value : ''
  return text.length > max ? text.slice(0, max) : text
}

/** Normalize an incoming list field into trimmed, comma-free items. */
function cleanList(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    // The CLI splits these flags on commas, so a comma inside an item would
    // silently become a second item; collapse it into a space instead.
    const item = raw.replace(/,/g, ' ').trim()
    if (item === '') continue
    out.push(item.slice(0, maxLen))
    if (out.length >= maxItems) break
  }
  return out
}

/**
 * Parse a positive integer id out of a JSON value.
 * @returns the id, or `null` when the value is not one.
 */
function parseId(value) {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(id) || Math.floor(id) !== id || id <= 0) return null
  return id
}

/** File facts for the status card; a missing file is reported, not thrown. */
async function describeDatabase(dbPath) {
  try {
    const info = await stat(dbPath)
    const described = {
      path: dbPath,
      sizeBytes: info.size,
      updatedAt: new Date(info.mtimeMs).toISOString(),
    }
    for (const [suffix, key] of [['-wal', 'walSizeBytes'], ['-shm', 'shmSizeBytes']]) {
      try {
        described[key] = (await stat(dbPath + suffix)).size
      } catch {
        /* sidecar absent */
      }
    }
    return described
  } catch (error) {
    return { path: dbPath, missing: true, error: describe(error) }
  }
}

/** Map every known projectId/alias to its project root. */
async function readProjectRoots(config) {
  const roots = new Map()
  let lastRoot
  try {
    const parsed = JSON.parse(await readFile(join(config.home, 'data', '.project-aliases.json'), 'utf8'))
    for (const group of Array.isArray(parsed?.groups) ? parsed.groups : []) {
      const root = Array.isArray(group?.rootPaths) ? group.rootPaths[0] : undefined
      if (typeof root !== 'string' || root === '') continue
      if (typeof group?.canonical === 'string') roots.set(group.canonical, root)
      for (const alias of Array.isArray(group?.aliases) ? group.aliases : []) roots.set(alias, root)
    }
  } catch {
    /* aliases file absent: last-project-root remains the only hint */
  }
  try {
    const value = (await readFile(join(config.home, 'last-project-root'), 'utf8')).trim()
    if (value !== '') lastRoot = value
  } catch {
    /* no recorded root */
  }
  return { roots, lastRoot }
}

/**
 * Read the CLI's own version banner (`memorix --version` prints plain text,
 * not the `--json` envelope the other calls use).
 * @returns the first non-empty output line, or '' when the CLI is missing.
 */
async function readCliVersion(config) {
  try {
    const { stdout, stderr } = await execFileAsync(config.bin, ['--version'], {
      timeout: config.cliTimeoutMs,
      maxBuffer: 1024 * 1024,
      env: process.env,
    })
    const line = String(stdout || stderr || '').trim().split('\n')[0]
    return line ?? ''
  } catch (error) {
    const line = String(error?.stdout || error?.stderr || '').trim().split('\n')[0]
    return line ?? ''
  }
}

/** Run the memorix CLI and parse its `--json` envelope. */
async function runMemorix(config, args) {
  try {
    const { stdout, stderr } = await execFileAsync(config.bin, args, {
      timeout: config.cliTimeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    })
    const parsed = JSON.parse(stdout)
    return { ok: true, parsed, stderr }
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    let parsed
    try {
      parsed = stdout === '' ? undefined : JSON.parse(stdout)
    } catch {
      parsed = undefined
    }
    if (parsed?.error) return { ok: false, parsed, stderr: describe(error) }
    const detail = [describe(error), typeof error?.stderr === 'string' ? error.stderr.trim() : '']
      .filter((part) => part !== '')
      .join(' | ')
    return { ok: false, parsed: undefined, stderr: detail.slice(0, 600) }
  }
}

// ── long-term (durable) memory ─────────────────────────────────────────────

/**
 * Read the three durable-memory tables, whichever backend works.
 * Both backends return the same shape: table name → array of row objects.
 * @param config - resolved plugin config.
 * @returns the raw tables; missing tables come back as empty arrays.
 */
async function readLongTermTables(config) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(config.dbPath, { readOnly: true })
    try {
      const out = {}
      for (const table of LONG_TERM_TABLES) {
        try {
          out[table] = db.prepare('SELECT * FROM ' + table).all()
        } catch {
          out[table] = []
        }
      }
      return out
    } finally {
      db.close()
    }
  } catch (sqliteError) {
    const script = [
      'import sqlite3, json, sys',
      "con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
      'out = {}',
      'for table in ' + JSON.stringify(LONG_TERM_TABLES) + ':',
      '    try:',
      '        cur = con.execute("SELECT * FROM " + table)',
      '        cols = [d[0] for d in cur.description]',
      '        out[table] = [dict(zip(cols, row)) for row in cur.fetchall()]',
      '    except Exception:',
      '        out[table] = []',
      'print(json.dumps(out, ensure_ascii=False))',
    ].join('\n')
    try {
      const { stdout } = await execFileAsync('python3', ['-', config.dbPath], {
        input: script,
        timeout: 30000,
        maxBuffer: 32 * 1024 * 1024,
      })
      return JSON.parse(stdout)
    } catch (pythonError) {
      const error = new Error(HOST_TEXT['read.longTermUnavailable'])
      error.code = 'read.longTermUnavailable'
      error.detail = 'node:sqlite: ' + describe(sqliteError) + ' | python3: ' + describe(pythonError)
      throw error
    }
  }
}

/** Parse one JSON-encoded list column; anything unexpected becomes []. */
function parseJsonList(value) {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item === null || typeof item !== 'object').map(String)
  } catch {
    return []
  }
}

/**
 * Assemble the durable-memory payload: every record with its evidence chain
 * and audit trail, ordered live-first then by recency.
 * @param config - resolved plugin config.
 * @returns the `/memorix-panel/api` response body for `action: 'long-term'`.
 */
async function loadLongTerm(config) {
  const tables = await readLongTermTables(config)
  const evidenceBy = new Map()
  for (const row of tables.long_term_memory_evidence ?? []) {
    const list = evidenceBy.get(row.memoryId) ?? []
    list.push({
      kind: row.kind ?? '',
      relation: row.relation ?? '',
      referenceId: row.referenceId ?? '',
      createdAt: row.createdAt ?? '',
    })
    evidenceBy.set(row.memoryId, list)
  }
  const eventsBy = new Map()
  for (const row of tables.long_term_memory_events ?? []) {
    const list = eventsBy.get(row.memoryId) ?? []
    list.push({
      kind: row.kind ?? '',
      fromState: row.fromState ?? null,
      toState: row.toState ?? null,
      detail: row.detail ?? '',
      createdAt: row.createdAt ?? '',
    })
    eventsBy.set(row.memoryId, list)
  }
  const memories = (tables.long_term_memories ?? []).map((row) => ({
    id: row.id,
    title: row.title ?? '',
    state: row.state ?? '',
    scope: row.scope ?? '',
    kind: row.kind ?? '',
    portability: row.portability ?? '',
    originProjectId: row.originProjectId ?? '',
    origin: row.origin ?? '',
    applicability: row.applicability ?? '',
    content: String(row.content ?? '').slice(0, 8000),
    facts: parseJsonList(row.factsJson),
    tags: parseJsonList(row.tagsJson),
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? '',
    qualifiedAt: row.qualifiedAt ?? null,
    approvedAt: row.approvedAt ?? null,
    archivedAt: row.archivedAt ?? null,
    supersededBy: row.supersededBy ?? null,
    accessCount: row.accessCount ?? 0,
    evidence: evidenceBy.get(row.id) ?? [],
    events: (eventsBy.get(row.id) ?? []).slice(-20),
  }))
  const rank = (state) => {
    const index = LONG_TERM_STATE_ORDER.indexOf(state)
    return index < 0 ? LONG_TERM_STATE_ORDER.length : index
  }
  memories.sort((left, right) => {
    const byState = rank(left.state) - rank(right.state)
    if (byState !== 0) return byState
    return String(right.updatedAt).localeCompare(String(left.updatedAt))
  })
  const byState = {}
  const byScope = {}
  for (const memory of memories) {
    byState[memory.state] = (byState[memory.state] ?? 0) + 1
    byScope[memory.scope] = (byScope[memory.scope] ?? 0) + 1
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts: { total: memories.length, byState, byScope },
    memories,
  }
}

// ── actions ────────────────────────────────────────────────────────────────

/**
 * Drive one durable-memory lifecycle transition through the official CLI.
 * The three verbs mirror Memorix's own state machine — candidate →(qualify)→
 * qualified →(approve)→ approved, plus archive — so the transition rules stay
 * where Memorix owns them; a wrong order comes back as a CLI error.
 * @param config - resolved plugin config.
 * @param payload - `{ id, verb, reason?, projectId? }` (`verb` is qualify/approve/archive;
 *                  it is deliberately not named `action`, which is the API's own field).
 * @returns the `/memorix-panel/api` response body.
 */
async function ltTransition(config, payload) {
  if (!config.allowWrite) return fail('lt.writeDisabled')
  const id = typeof payload?.id === 'string' ? payload.id.trim() : ''
  if (!/^[A-Za-z0-9-]{8,80}$/.test(id)) return fail('lt.invalidId')
  const verb = typeof payload?.verb === 'string' ? payload.verb : ''
  if (!LONG_TERM_ACTIONS.includes(verb)) {
    return fail('lt.invalidAction')
  }
  const reason = clampText(payload?.reason, 300).replace(/[\r\n]+/g, ' ').trim() || '面板操作'
  const wanted = typeof payload?.projectId === 'string' ? payload.projectId : ''
  const { roots, lastRoot } = await readProjectRoots(config)
  const root = wanted !== '' ? (roots.get(wanted) ?? lastRoot) : lastRoot
  if (root === undefined) {
    return fail('lt.projectRootMissing', { hintCode: 'hint.noProjectMapping' })
  }
  const result = await runMemorix(config, [
    'memory', 'long-term', verb, '--id', id, '--reason', reason, '--json', '--cwd', root,
  ])
  if (!result.ok) {
    if (typeof result.parsed?.error === 'string') return { ok: false, error: result.parsed.error, detail: result.stderr }
    return fail('lt.actionFailed', { detail: result.stderr })
  }
  const state = result.parsed?.memory?.state
  if (typeof state !== 'string' || state === '') {
    return fail('lt.noStateFromCli', { detail: JSON.stringify(result.parsed ?? {}).slice(0, 400) })
  }
  return { ok: true, id, verb, state, title: result.parsed?.memory?.title ?? '' }
}

/**
 * Full panel payload: store facts, per-project summaries and totals.
 * @returns the `/memorix-panel/api` response body.
 */
async function loadOverview(config) {
  const now = Date.now()
  const [{ snapshot, backend }, database, cliVersion] = await Promise.all([
    readSnapshot(config),
    describeDatabase(config.dbPath),
    readCliVersion(config),
  ])
  const projects = snapshot.projects.map((project) => ({
    id: project.id,
    total: project.total,
    active: project.active,
    archived: project.archived,
    resolved: project.resolved,
    firstAt: project.firstAt,
    lastAt: project.lastAt,
    types: project.types,
    memories: project.memories,
  }))
  const sum = (key) => projects.reduce((total, project) => total + (project[key] ?? 0), 0)
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    backend,
    readOnly: !config.allowWrite,
    storeAllowed: config.allowStore,
    db: database,
    cliVersion,
    projectRoot: config.home,
    projects,
    totals: {
      projects: projects.length,
      memories: sum('total'),
      active: sum('active'),
      archived: sum('archived'),
      resolved: sum('resolved'),
      ...snapshot.totals,
    },
  }
}

/**
 * One memory's full record (narrative, facts, concepts, provenance).
 * @returns the `/memorix-panel/api` response body.
 */
async function loadMemory(config, id) {
  const { snapshot } = await readSnapshot(config)
  const known = snapshot.projects.some((project) => project.memories.some((memory) => memory.id === id))
  if (!known) {
    // The list is capped per project, so fall through to a direct read below.
    const detail = await readMemoryRow(config, id)
    return detail
  }
  return readMemoryRow(config, id)
}

/** Direct single-row read (used by the detail view). */
async function readMemoryRow(config, id) {
  const columns = [
    'id', 'entityName', 'type', 'title', 'narrative', 'facts', 'filesModified', 'concepts', 'tokens',
    'createdAt', 'updatedAt', 'projectId', 'topicKey', 'revisionCount', 'sessionId', 'status', 'source',
    'commitHash', 'relatedCommits', 'relatedEntities', 'valueCategory', 'admissionState', 'visibility',
  ]
  const parseList = (value) => {
    if (typeof value !== 'string' || value === '') return []
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item !== 'object' || item === null) : []
    } catch {
      return []
    }
  }
  let record
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(config.dbPath, { readOnly: true })
    try {
      record = db.prepare('SELECT ' + columns.join(',') + ' FROM observations WHERE id=?').get(id)
    } finally {
      db.close()
    }
  } catch {
    const script = [
      'import sqlite3, json, sys',
      "con = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
      'cols = ' + JSON.stringify(columns),
      'row = con.execute("SELECT " + ",".join(cols) + " FROM observations WHERE id=?", (int(sys.argv[2]),)).fetchone()',
      'print(json.dumps(dict(zip(cols, row)) if row else None, ensure_ascii=False))',
    ].join('\n')
    const { stdout } = await execFileAsync('python3', ['-', config.dbPath, String(id)], {
      input: script,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
    })
    record = JSON.parse(stdout)
  }
  if (!record) return fail('memory.notFound', { params: { id } })
  record.facts = parseList(record.facts)
  record.filesModified = parseList(record.filesModified)
  record.concepts = parseList(record.concepts)
  record.relatedCommits = parseList(record.relatedCommits)
  record.relatedEntities = parseList(record.relatedEntities)
  return { ok: true, memory: record }
}

/** Resolve the project root that owns one observation. */
async function rootForMemory(config, id) {
  const { snapshot } = await readSnapshot(config)
  let projectId
  for (const project of snapshot.projects) {
    if (project.memories.some((memory) => memory.id === id)) {
      projectId = project.id
      break
    }
  }
  const { roots, lastRoot } = await readProjectRoots(config)
  if (projectId !== undefined) {
    const root = roots.get(projectId)
    if (root !== undefined) return { projectId, root }
  }
  if (lastRoot !== undefined) return { projectId, root: lastRoot }
  return { projectId, root: undefined }
}

/**
 * Change one memory's status through the official CLI.
 * @returns the `/memorix-panel/api` response body.
 */
async function setStatus(config, payload) {
  if (!config.allowWrite) return fail('write.statusDisabled')
  const id = parseId(payload?.id)
  if (id === null) return fail('memory.invalidId')
  const status = typeof payload?.status === 'string' ? payload.status : ''
  if (!STATUSES.includes(status)) {
    return fail('write.invalidStatus')
  }
  const { projectId, root } = await rootForMemory(config, id)
  if (root === undefined) {
    return fail('write.projectRootMissing', { hintCode: 'hint.noProjectMapping' })
  }
  const result = await runMemorix(config, ['memory', 'resolve', '--id', String(id), '--status', status, '--json', '--cwd', root])
  if (!result.ok) {
    if (typeof result.parsed?.error === 'string') return { ok: false, error: result.parsed.error, detail: result.stderr }
    return fail('write.failed', { detail: result.stderr })
  }
  const applied = Array.isArray(result.parsed?.result?.resolved) ? result.parsed.result.resolved : []
  if (!applied.some((value) => Number(value) === id)) {
    return fail('write.notUpdated', { hintCode: 'hint.cliProject', hintParams: { root } })
  }
  return { ok: true, id, status, project: result.parsed?.project?.id ?? projectId }
}

/**
 * Store one new memory through the official CLI.
 * @returns the `/memorix-panel/api` response body.
 */
async function storeMemory(config, payload) {
  if (!config.allowStore) return fail('store.disabled')
  const title = clampText(payload?.title, LIMITS.title).replace(/[\r\n]+/g, ' ').trim()
  const text = clampText(payload?.text, LIMITS.text)
  if (title === '') return fail('store.emptyTitle')
  if (text.trim() === '') return fail('store.emptyBody')
  const type = TYPES.includes(payload?.type) ? payload.type : 'discovery'
  const entity = clampText(payload?.entity, LIMITS.entity).replace(/[\r\n]+/g, ' ').trim()
  const topicKey = clampText(payload?.topicKey, LIMITS.topicKey).replace(/[\r\n]+/g, ' ').trim()
  const facts = cleanList(payload?.facts, LIMITS.listItems, LIMITS.listItem)
  const concepts = cleanList(payload?.concepts, LIMITS.listItems, LIMITS.listItem)
  const files = cleanList(payload?.files, LIMITS.listItems, LIMITS.listItem)

  const wanted = typeof payload?.projectId === 'string' ? payload.projectId : ''
  const { roots, lastRoot } = await readProjectRoots(config)
  const root = wanted !== '' ? roots.get(wanted) : lastRoot
  if (root === undefined) {
    return wanted === ''
      ? fail('store.projectRootMissing', { hintCode: 'hint.noLastProjectRoot' })
      : fail('store.projectRootMissing', { hintCode: 'hint.projectNotRegistered', hintParams: { projectId: wanted } })
  }

  const args = ['memory', 'store', '--text', text, '--title', title, '--type', type, '--json', '--cwd', root]
  if (entity !== '') args.push('--entity', entity)
  if (topicKey !== '') args.push('--topicKey', topicKey)
  if (facts.length > 0) args.push('--facts', facts.join(','))
  if (concepts.length > 0) args.push('--concepts', concepts.join(','))
  if (files.length > 0) args.push('--files', files.join(','))

  const result = await runMemorix(config, args)
  if (!result.ok) {
    if (typeof result.parsed?.error === 'string') return { ok: false, error: result.parsed.error, detail: result.stderr }
    return fail('write.failed', { detail: result.stderr })
  }
  const observation = result.parsed?.observation
  if (!observation?.id) {
    return fail('store.noMemoryFromCli', { detail: JSON.stringify(result.parsed).slice(0, 400) })
  }
  return {
    ok: true,
    id: observation.id,
    title: observation.title ?? title,
    status: observation.status ?? 'active',
    upserted: result.parsed?.upserted === true,
    project: result.parsed?.project?.id ?? wanted,
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────

/** Whether one hostname is loopback (mirrors the shipped gateway fence). */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost')
    || /^127\./.test(hostname)
}

/**
 * Fence one request to same-origin browser traffic from a trusted authority.
 * @param ctx - plugin context (reads the live web runtime trust list).
 * @param req - the incoming request.
 * @returns true when the request may reach the panel API.
 */
function isTrustedRequest(ctx, req) {
  const hostHeader = req.headers.host
  if (typeof hostHeader !== 'string' || hostHeader === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + hostHeader)
  } catch {
    return false
  }
  const runtime = ctx.get('webRuntime')
  const trustedHosts = Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : []
  const authorityTrusted = isLoopbackHostname(hostUrl.hostname) || trustedHosts.some((entry) => {
    const value = String(entry)
    try {
      return new URL(value.includes('://') ? value : 'http://' + value).hostname === hostUrl.hostname
    } catch {
      return false
    }
  })
  if (!authorityTrusted) return false
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** Write one JSON response with no-store caching. */
function writeJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Collect a bounded request body. */
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Mount the panel API.
 * @param ctx - plugin context carrying `webServer`.
 * @param config - the row's raw config block.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequest(ctx, req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let payload
      try {
        const body = await readBody(req)
        payload = body === '' ? {} : JSON.parse(body)
      } catch (error) {
        writeJson(res, 400, fail('request.badBody', { detail: describe(error) }))
        return
      }
      const action = typeof payload?.action === 'string' ? payload.action : 'overview'
      try {
        let result
        switch (action) {
          case 'overview':
            result = await loadOverview(resolved)
            break
          case 'memory': {
            const id = parseId(payload?.id)
            result = id === null ? fail('memory.invalidId') : await loadMemory(resolved, id)
            break
          }
          case 'set-status':
            result = await setStatus(resolved, payload)
            break
          case 'long-term':
            result = await loadLongTerm(resolved)
            break
          case 'lt-transition':
            result = await ltTransition(resolved, payload)
            break
          case 'store':
            result = await storeMemory(resolved, payload)
            break
          default:
            result = fail('request.unknownAction', { params: { action } })
        }
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 200, {
          ok: false,
          code: typeof error?.code === 'string' ? error.code : undefined,
          error: describe(error),
          detail: typeof error?.detail === 'string' ? error.detail : undefined,
        })
      }
    },
  }), 'dsh-memorix-panel: /memorix-panel/api')
}
