const fs = require('fs')
const path = require('path')
const { GraphDumper } = require('./utils')

const OpKind = Object.freeze({
    CRAFT: 'craft',
    FURNACE: 'furnace',
    SMOKE: "smoke",
    BREW: "brew",
    STONECUT: "stonecut",
    SMITH: "smith",

    // interaction
    MINE: "mine",
    KILL: "kill",
    PLACE: "place",
    USE: "use",
})
class GameGraph {
    constructor(mcData, outdir) {
        this.game_data = mcData;
        this.recipes = null;
        this.items = null;
        this.blocks = null;
        this.entities = null;       
        
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
        const countsPath = path.join(this.writer.outdir, "counts.json");
        this.validateGraph();
        return fs.existsSync(countsPath);
    }
    buildGraph() {
        if (this.graphAlreadyBuilt()) {
            console.log('Graph already built. Skipping build.');
            return;
        }
        for (const [name, item] of Object.entries(this.items)) {
            this.addObject('item', name, item);
        }

        for (const [name, block] of Object.entries(this.blocks)) {
            this.addObject('block', name, block);
        }

        const craftingTableStateId = this.addObject('state', 'station:crafting_table', {});

        for (const [outName, variants] of Object.entries(this.recipes)) {
            if (!outName || outName == "air") {
                continue;
            }
            const outObjId = this.addObject('item', outName, this.items[outName] ?? {});

            for (const variant of variants) {
                const opId = this.getName('op', `craft:${outName}#${variant.variant}`);
                this.addOp({ id: opId, kind: OpKind.CRAFT, name: outName, meta: { variant, requiresTable: !!variant.requiresTable } });

                if (variant.requiresTable) {
                    this.addRequire(opId, craftingTableStateId, 1, 'precond');
                }

                for (const [inName, inCount] of Object.entries(variant.ingredients) ?? {}) {
                    const inObjId = this.addObject('item', inName, this.items[inName] ?? {});
                    this.addRequire(opId, inObjId, inCount, "consumed");
                }

                this.addProduce(opId, outObjId, variant.resultCount ?? 1);
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

        const out_dir = path.join(process.cwd(), 'assets', 'gamegraph');
        const out_path = path.join(out_dir, `minecraft_${version}.json`);

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
}

module.exports = { GameGraph };
