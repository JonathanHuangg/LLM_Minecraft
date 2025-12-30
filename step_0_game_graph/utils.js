const fs = require("fs");
const path = require("path");

class GraphDumper {
    constructor(outdir) {
        fs.mkdirSync(outdir, { recursive: true });
        this.outdir = outdir;

        // Single-file graph output
        this.fullOps = fs.createWriteStream(path.join(outdir, "full_graph.jsonl"), { flags: "w" });
    }

    // Deprecated granular writers; kept as no-ops to preserve call sites
    writeObject(obj) {
        void obj;
    }
    writeOp(op) {
        void op;
    }
    writeRequire(edge) {
        void edge;
    }
    writeProduce(edge) {
        void edge;
    }


    // new technique
    writeOpRecord(op, req = [], prod = []) {
        const record = {
            id: op.id,
            kind: op.kind, 
            name: op.name,
            meta: op.meta ?? {},
            req, 
            prod
        };

        this.fullOps.write(JSON.stringify(record) + "\n");
    }
    close() {
        this.fullOps.end();
    }
}

module.exports = { GraphDumper };
