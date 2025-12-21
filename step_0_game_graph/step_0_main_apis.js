const { GameGraph } = require('./main')

class GameGraphApi {
    constructor(mcData, outDir) {
        this.graph = new GameGraph(mcData, outDir)
        this.graph.fetch_game_data()
        this.graph.buildGraph()
    }

    getFrontiers() {
        
    }
}

module.exports = { GameGraphApi };
