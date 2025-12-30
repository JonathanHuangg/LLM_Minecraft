const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { table } = require('console')

// download server jar, read tags, expand tags, read loot tables, expand loot tables
async function fetchJson(url) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`)
    return res.json()
}

async function downloadTo(url, filepath) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    fs.mkdirSync(path.dirname(filepath), { recursive: true })
    fs.writeFileSync(filepath, buf)
}

async function getServerJarUrl(version) {
    const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
    const entry = manifest.versions.find(v => v.id === version)
    if (!entry) throw new Error(`Version not found: ${version}`)

    const versionedJson = await fetchJson(entry.url)
    const serverUrl = versionedJson?.downloads?.server?.url
    if (!serverUrl) throw new Error(`No server JAR for version ${version}`)
    return serverUrl
}

function normalizeId(id, defaultNs = 'minecraft') {
    if (typeof id !== 'string' || id.length === 0) return null
    return id.includes(':') ? id : `${defaultNs}:${id}`
}

function readZipJson(zip, entryName) {
    const e = zip.getEntry(entryName)
    if (!e) return null
    return JSON.parse(e.getData().toString('utf8'))
}

/**
 * Parse all item tags from the jar:
 * data/<ns>/tags/items/<rel>.json
 * Returns Map<tagId, values[]> where values are raw strings like
 *   "minecraft:stone", "#minecraft:planks", or objects {id, required}
 */
function parseItemTags(zip) {
    const res = new Map()
    const re = /^data\/([^/]+)\/tags\/items\/(.+)\.json$/

    for (const e of zip.getEntries()) {
        const name = e.entryName
        const m = name.match(re)
        if (!m) continue

        const ns = m[1]
        const rel = m[2]
        const tagId = `${ns}:${rel}`

        const json = JSON.parse(e.getData().toString('utf8'))
        const values = Array.isArray(json.values) ? json.values : []
        res.set(tagId, values)
    }
    return res
}

/**
 * Expand tags so that each tagId maps to Set(itemId).
 * Handles nested tags (#...) and cycles.
 */
function buildExpandedTagIndex(rawTagMap) {
  const expanded = new Map()

  function expand(tagId, visiting = new Set()) {
    if (expanded.has(tagId)) return expanded.get(tagId)
    if (visiting.has(tagId)) return new Set() // cycle

    visiting.add(tagId)

    const values = rawTagMap.get(tagId) ?? []
    const items = new Set()

    for (const v of values) {
        let s = null
        if (typeof v === 'string') s = v
        else if (v && typeof v === 'object' && typeof v.id === 'string') s = v.id
        else continue

        if (s.startsWith('#')) {
            const refTag = s.slice(1)
            const refId = normalizeId(refTag)
            if (!refId) continue
            const refItems = expand(refId, visiting)
            for (const it of refItems) items.add(it)
        } else {
            const itemId = normalizeId(s)
            if (itemId) items.add(itemId)
        }
    }

    visiting.delete(tagId)
    expanded.set(tagId, items)
    return items
    }

    for (const tagId of rawTagMap.keys()) expand(tagId)
    return expanded
}

function zipHasDataRoot(zip) {
    return zip.getEntries().some(e => e.entryName.startsWith('data/'))
}

function findNestedServerJar(zip, version) {
    const candidates = [
        `META-INF/versions/${version}/server-${version}.jar`,
        `versions/${version}/server-${version}.jar`,
        `server-${version}.jar`
    ]

    for (const name of candidates) {
        const entry = zip.getEntry(name)
        if (entry) return new AdmZip(entry.getData())
    }

    // fallback: any jar under META-INF/versions
    for (const e of zip.getEntries()) {
        if (/^META-INF\/versions\/.+\.jar$/.test(e.entryName)) {
            return new AdmZip(e.getData())
        }
    }
    return null
}

function getTableIdFromPath(p) {
    const m = p.match(/^data\/([^/]+)\/loot_tables\/(.+)\.json$/)
    if (!m) return null
    return `${m[1]}:${m[2]}`
}

function inferSourceType(tableId) {
    const rel = tableId.split(':')[1] || ''
    const top = rel.split('/')[0]
    if (top === 'entities') return 'entity'
    if (top === 'blocks') return 'block'
    if (top === 'chests') return 'chest'
    if (top === 'gameplay') return 'gameplay'
    if (top === 'archaeology') return 'archaeology'
    return 'other'
}

function collectFromNode(node, acc) {
    if (node == null) return

    if (Array.isArray(node)) {
        for (const x of node) collectFromNode(x, acc)
        return
    }

    if (typeof node !== 'object') return

    // Loot-table entry detection
    if (typeof node.type === 'string') {
        if (node.type === 'minecraft:item' && typeof node.name === 'string') {
            const itemId = normalizeId(node.name)
            if (itemId) acc.items.add(itemId)
        }

        if (node.type === 'minecraft:tag' && typeof node.name === 'string') {
            const tagId = normalizeId(node.name)
            if (tagId) acc.tags.add(tagId)
        }

        if (node.type === 'minecraft:loot_table') {
            const v = typeof node.value === 'string' ? node.value : (typeof node.name === 'string' ? node.name : null)
            const ref = normalizeId(v)
            if (ref) acc.tableRefs.add(ref)
        }
    }

    for (const k of Object.keys(node)) {
        collectFromNode(node[k], acc)
    }
}

function parseLootTable(json) {
  const acc = { items: new Set(), tags: new Set(), tableRefs: new Set() }
  collectFromNode(json, acc)
  return acc
}

function resolveLootTables(zip, expandedTags) {
  const meta = {}
  const re = /^data\/([^/]+)\/loot_tables\/.+\.json$/

  for (const e of zip.getEntries()) {
    const name = e.entryName
    if (!re.test(name)) continue

    const tableId = getTableIdFromPath(name)
    if (!tableId) continue

    const json = JSON.parse(e.getData().toString('utf8'))
    const parsed = parseLootTable(json)

    meta[tableId] = {
      sourceType: inferSourceType(tableId),
      items: parsed.items,
      tags: parsed.tags,
      tableRefs: parsed.tableRefs
    }
  }

  function closureItems(tableId, visiting = new Set()) {
    if (visiting.has(tableId)) return new Set()
    visiting.add(tableId)

    const t = meta[tableId]
    if (!t) {
      visiting.delete(tableId)
      return new Set()
    }

    const out = new Set([...t.items])

    for (const tagId of t.tags) {
      const tagItems = expandedTags.get(tagId)
      if (!tagItems) continue
      for (const it of tagItems) out.add(it)
    }

    for (const refTable of t.tableRefs) {
      const sub = closureItems(refTable, visiting)
      for (const it of sub) out.add(it)
    }

        visiting.delete(tableId)
        return out
    }

    const tableToItems = {}
    const itemToSources = {}

    for (const tableId of Object.keys(meta)) {
        const items = closureItems(tableId)
        tableToItems[tableId] = items

        const sourceType = meta[tableId].sourceType
        for (const itemId of items) {
            if (!itemToSources[itemId]) {
                itemToSources[itemId] = []
            }
        itemToSources[itemId].push({ type: sourceType, table: tableId })
    }
}

  return { tableToItems, meta, itemToSources }
}

async function fetchLootIndexForVersion(version, cacheDirectory) {
    fs.mkdirSync(cacheDirectory, { recursive: true })
    const jarPath = path.join(cacheDirectory, `server_${version}.jar`)

    if (!fs.existsSync(jarPath)) {
    const jarUrl = await getServerJarUrl(version)
    await downloadTo(jarUrl, jarPath)
    }

    let zip = new AdmZip(jarPath)
    if (!zipHasDataRoot(zip)) {
        const nested = findNestedServerJar(zip, version)
        if (!nested) throw new Error(`Could not locate data files in server jar for version ${version}`)
        zip = nested
    }
    const rawTags = parseItemTags(zip)
    const expandedTags = buildExpandedTagIndex(rawTags)
    return resolveLootTables(zip, expandedTags)
}

module.exports = { fetchLootIndexForVersion }
