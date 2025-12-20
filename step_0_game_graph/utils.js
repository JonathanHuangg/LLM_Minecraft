const fs = require("fs");
const path = require("path");

class GraphDumper {
    constructor(outdir) {
        fs.mkdirSync(outdir, { recursive: true });
        this.outdir = outdir;

        this.objectsW = fs.createWriteStream(path.join(outdir, "objects.jsonl"), { flags: "w" });
        this.opsW = fs.createWriteStream(path.join(outdir, "ops.jsonl"), { flags: "w" });
        this.requiresW = fs.createWriteStream(path.join(outdir, "requires.jsonl"), { flags: "w" });
        this.producesW = fs.createWriteStream(path.join(outdir, "produces.jsonl"), { flags: "w" });

        this.counts = { objects: 0, ops: 0, requires: 0, produces: 0 };
    }

    writeObject(obj) {
    this.objectsW.write(JSON.stringify(obj) + "\n");
    this.counts.objects++;
    }
    writeOp(op) {
        this.opsW.write(JSON.stringify(op) + "\n");
        this.counts.ops++;
    }
    writeRequire(edge) {
        this.requiresW.write(JSON.stringify(edge) + "\n");
        this.counts.requires++;
    }
    writeProduce(edge) {
        this.producesW.write(JSON.stringify(edge) + "\n");
        this.counts.produces++;
    }

    close() {
        this.objectsW.end();
        this.opsW.end();
        this.requiresW.end();
        this.producesW.end();
        fs.writeFileSync(path.join(this.outdir, "counts.json"), JSON.stringify(this.counts, null, 2));
    }
}

module.exports = { GraphDumper };
