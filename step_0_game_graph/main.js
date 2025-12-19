const fs = require('fs')
const path = require('path')

class GameObjectNode {
    constructor(name, children) {
        this.name = name;
        this.children = children;
    }
}

/*
name: ex: "planks_from_log"
num_components_needed: List[int]
components: List[GameOpNode]
*/
class GameOpNode {
    constructor(name, num_components_needed, components) {
        this.name = name;
        this.num_components_needed = num_components_needed;
        this.components = components;
    }
}

class GameGraph {
    constructor(mcData) {
        this.game_data = mcData;
        this.recipes = null;
        this.items = null;
        this.blocks = null;
        this.entities = null;        
    }

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

module.exports = { GameObjectNode, GameOpNode, GameGraph };
