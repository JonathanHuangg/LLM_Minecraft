const fs = require('fs')
const path = require('path')
const { GraphDumper } = require('./utils')
const { fetchLootIndexForVersion } = require('./loot_fetcher')

const OpKind = Object.freeze({
    CRAFT: 'craft',
    FURNACE: 'furnace',
    SMOKE: "smoke",
    BREW: "brew",
    STONECUT: "stonecut",
    SMITH: "smith",

    // interaction
    LOOT: "loot",
    MINE: "mine",
    KILL: "kill",
    PLACE: "place",
    USE: "use",
})

const STATIONS = [
    'station:crafting_table',
    'station:furnace',
    'station:smoker',
    'station:blast_furnace',
    'station:stonecutter',
    'station:smithing_table',
    'station:brewing_stand',
];

const GAMEGRAPH_DIR = path.resolve(__dirname, '..', 'assets', 'gamegraph');

class GameGraph {
    constructor(mcData, outdir) {
        this.game_data = mcData;
        this.recipes = null;
        this.items = null;
        this.blocks = null;
        this.entities = null;       
        this.loot = null;
        // outdated and changed for disk streaming but still useful:
        // registry of objects in this world
        // registry of operations that can be executed
        // before operation is executed, need x objects 
        // after operation is executed, produces y objects
        // given an object, which operations produce it

        this.writer = new GraphDumper(outdir);

        this.seen_objects = new Set();
        this.seen_operations = new Set();

        this.errors = [];
    }

    validateGraph() {
        if (this.errors.length > 0) {
            console.error('Graph validation failed with errors:', this.errors);
            return false;
        } 

        console.log('Graph validation passed successfully.');
        return true;
    }

    graphAlreadyBuilt() {
        const countsPath = path.join(this.writer.outdir, "full_graph.jsonl");
        this.validateGraph();
        return fs.existsSync(countsPath);
    }
    buildGraph() {
        for (const [name, item] of Object.entries(this.items)) {
            this.addObject('item', name, item);
        }

        for (const [name, block] of Object.entries(this.blocks)) {
            this.addObject('block', name, block);
        }

        // Station states (schema stabilization)
        const stationStateIds = {};
        for (const station of STATIONS) {
            stationStateIds[station] = this.addObject('state', station, {});
        }

        for (const [outName, variants] of Object.entries(this.recipes)) {
            if (!outName || outName === "air") continue;

            const outObjId = this.addObject('item', outName, this.items[outName] ?? {});

            for (const variant of variants) {
            const opId = this.getName('op', `craft:${outName}#${variant.variant}`);

            const op = {
                id: opId,
                kind: OpKind.CRAFT,
                name: outName,
                meta: { variant: variant.variant, requiresTable: !!variant.requiresTable }
            };

            // Must register op before edge-list writing to avoid validation errors
            this.addOp(op);

            const requirements = [];

            if (variant.requiresTable) {
                requirements.push({
                objId: stationStateIds['station:crafting_table'],
                count: 1,
                role: 'precond'
                });
            }

            for (const [inName, inCount] of Object.entries(variant.ingredients ?? {})) {
                const inObjId = this.addObject('item', inName, this.items[inName] ?? {});
                requirements.push({ objId: inObjId, count: inCount, role: "consumed" });
            }

            const prod = [{ objId: outObjId, count: variant.resultCount ?? 1 }];

            // New format (one record per op)
            this.writer.writeOpRecord(op, requirements, prod);

            for (const r of requirements) this.addRequire(opId, r.objId, r.count, r.role);
            for (const p of prod) this.addProduce(opId, p.objId, p.count);
            }
        }

        // add the loot tables
        const meta = this.loot.meta 
        const tableToItems = this.loot.tableToItems

        for (const [tableId, itemsSet] of Object.entries(tableToItems)) {
            const sourceType = meta[tableId]?.sourceType ?? 'other'
            let opKind = OpKind.LOOT 
            let opName = tableId
            let opId = this.getName('op', `loot:${tableId}`)

            if (sourceType === 'entity') {
                const entPath = tableId.split(':')[1].replace(/^entities\//, '')
                const entityId = `minecraft:${entPath}`
                opKind = OpKind.KILL
                opName = entityId
                opId = this.getName('op', `kill:${entityId}`) 
            }

            if (sourceType === 'block') {
                const blkPath = tableId.split(':')[1].replace(/^blocks\//, '')
                const blockId = `minecraft:${blkPath}`
                opKind = OpKind.MINE
                opName = blockId
                opId = this.getName('op', `mine:${blockId}`)
            }

            const op = { id: opId, kind: opKind, name: opName, meta: { tableId } }
            this.addOp(op)

            const requirements = []

            const prod = []
            for (const itemId of itemsSet) {
                const short = itemId.startsWith('minecraft:') ? itemId.split(':')[1] : itemId
                const outObjId = this.addObject('item', short, this.items[short] ?? {})
                prod.push({ objId: outObjId, count: 1 }) // count unknown; you can refine later
            }
            this.writer.writeOpRecord(op, requirements, prod)
            for (const p of prod) {
                this.addProduce(opId, p.objId, p.count)
            }

        }
        this.writer.close();
        this.validateGraph();
    }


    getName(kind, name) {
        return `${kind}:${name}`;
    }

    addObject(kind, name, meta = {}) {
        const id = this.getName(kind, name);
        if (!this.seen_objects.has(id)) {
            this.writer.writeObject({ id, kind, name });
            this.seen_objects.add(id);
        }
        return id;
    }

    addOp(op) {
        if (!this.seen_operations.has(op.id)) {
            const meta = op.meta ?? {};
            this.writer.writeOp({
                id: op.id,
                kind: op.kind,
                name: op.name,
                meta: { variant: meta.variant, requiresTable: meta.requiresTable }
            });
            this.seen_operations.add(op.id);
        }
    }

    addRequire(opId, objId, count, role="consumed") {
        if (!this.seen_operations.has(opId)) this.errors.push(`requires references missing op: ${opId}`);
        if (!this.seen_objects.has(objId)) this.errors.push(`requires references missing obj: ${objId} (op ${opId})`);
        this.writer.writeRequire({ opId, objId, count, role });
    }

    addProduce(opId, objId, count) {
        if (!this.seen_operations.has(opId)) this.errors.push(`produces references missing op: ${opId}`);
        if (!this.seen_objects.has(objId)) this.errors.push(`produces references missing obj: ${objId} (op ${opId})`);
        this.writer.writeProduce({ opId, objId, count });
    }

    // --- FETCHING GAME DATA
    inferRequiresTable(recipe) {
        if (typeof recipe.requiresTable === 'boolean') {
            return recipe.requiresTable;
        }

        if (recipe.inShape) {
            const rows = recipe.inShape.length
            const cols = Math.max(...recipe.inShape.map(row => row.length ?? 0))
            return rows > 2 || cols > 2
        }

        if (recipe.ingredients) {
            return recipe.ingredients.length > 4
        }

        return false
    }

    fetch_game_data() {
        const mcData = this.game_data;
        const version = mcData.version.minecraftVersion;
        
        console.log(' ')
        console.log(' ')
        console.log('=== minecraft-data loaded ===')
        console.log('version:', version)
        console.log('majorVersion:', mcData.version.majorVersion)
        
        const itemsCount = mcData.itemsArray?.length ?? Object.keys(mcData.items ?? {}).length
        const blocksCount = mcData.blocksArray?.length ?? Object.keys(mcData.blocks ?? {}).length
        const entitiesCount = mcData.entitiesArray?.length ?? Object.keys(mcData.entities ?? {}).length

        console.log('items:', itemsCount)
        console.log('blocks:', blocksCount)
        console.log('entities:', entitiesCount)

        const out_dir = GAMEGRAPH_DIR;
        const out_path = path.join(out_dir, `minecraft_${version}.json`);
        fs.mkdirSync(out_dir, { recursive: true })

        // items
        const items = {}
        for (const item of mcData.itemsArray ?? []) {
            items[item.name] = {
                id: item.id,
                stackSize: item.stackSize,
                components: item.components
            }
        }

        // blocks
        const blocks = {}
        for (const block of mcData.blocksArray ?? []) {
            blocks[block.name] = {
                id: block.id, 
                displayName: block.displayName,
                hardness: block.hardness,
                minStateId: block.minStateId,
                maxStateId: block.maxStateId,
                diggable: block.diggable,
                material: block.material,
                components: block.components
            }
        }

        // recipes
        const recipes = {}
        for (const [result_id, variants] of Object.entries(mcData.recipes ?? {})) {
            const result_id_id = Number(result_id)
            const resultItem = mcData.items?.[result_id_id]?.name

            recipes[resultItem] = variants.map((r, idx) => {
                const ingredients = {}

                if (r.ingredients) {
                    for (const ing of r.ingredients) {
                        const name = mcData.items[ing]?.name ?? `unknown_${ing}`
                        ingredients[name] = (ingredients[name] ?? 0) + 1
                    }
                }

                if (r.inShape) {
                    for (const row of r.inShape) {
                        for (const ing of row) {
                            if (ing == null) continue
                            const name = mcData.items[ing]?.name ?? `unknown_${ing}`
                            ingredients[name] = (ingredients[name] ?? 0) + 1
                        }
                    }
                }
                return {
                    variant: idx,
                    requiresTable: this.inferRequiresTable(r),
                    ingredients,
                    resultCount: r.result?.count ?? 1
                }
            })
        }



        const entities = mcData.entitiesArray ?? []
        const snapshot = {
            version: {
                minecraftVersion: version,
                majorVersion: mcData.version.majorVersion
            },
            counts: {
                items: Object.keys(items).length,
                blocks: Object.keys(blocks).length,
                entities: entities.length,
                recipeOutputs: Object.keys(recipes).length
            },
            items,
            blocks,
            entities,
            recipes
        }
        
        this.items = items 
        this.blocks = blocks
        this.recipes = recipes
        fs.writeFileSync(out_path, JSON.stringify(snapshot, null, 2))
        console.log(`Game data written to ${out_path}`)
    }

    async fetch_loot_data() {
        const version = this.game_data.version.minecraftVersion
        const cacheDir = path.join(GAMEGRAPH_DIR, '.cache')
        const outDir = GAMEGRAPH_DIR
        const outPath = path.join(outDir, `minecraft_${version}_loot.json`)
        
        const loot = await fetchLootIndexForVersion(version, cacheDir)

        const setMapToArrays = (obj) =>
            Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Array.from(v ?? [])]))

        const jsonOut = {
            version,
            counts: {
                lootTables: Object.keys(loot.tableToItems).length,
                itemsWithSources: Object.keys(loot.itemToSources).length
            },
            tableToItems: setMapToArrays(loot.tableToItems),
            itemToSources: loot.itemToSources,
            tableMeta: Object.fromEntries(
                Object.entries(loot.meta).map(([k, v]) => [k, {
                    sourceType: v.sourceType,
                    items: Array.from(v.items ?? []),
                    tags: Array.from(v.tags ?? []),
                    tableRefs: Array.from(v.tableRefs ?? [])
                }])
            )
        }

        fs.mkdirSync(outDir, {recursive: true})
        fs.writeFileSync(outPath, JSON.stringify(jsonOut, null, 2))
        console.log(`Loot data written to ${outPath}`)

        this.loot = loot
    }
}

module.exports = { GameGraph };
