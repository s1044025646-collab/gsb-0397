// 端到端演示：导入 -> 展开 -> 来源链 -> 修改父条目 -> 比较 -> 导出
import { Service } from "../dist/src/service.js";
import { Store } from "../dist/src/store.js";
import { readFileSync } from "node:fs";

const svc = new Service(new Store("data/demo.db"));
const v1 = svc.import(readFileSync("examples/demo.bib", "utf8"));
console.log("== 导入 v1 ==", JSON.stringify(v1));
console.log("== 展开 C ==", JSON.stringify(svc.expandEntry("C"), null, 2));
console.log("== publisher 来源链 ==", JSON.stringify(svc.provenance("C", "publisher"), null, 2));
const v2 = svc.import(readFileSync("examples/demo.bib", "utf8").replace("青山", "青山（修订版）"));
console.log("== 导入 v2（修改宏） ==", JSON.stringify(v2));
console.log("== diff v1..v2 ==", JSON.stringify(svc.diff(v1.version, v2.version), null, 2));
console.log("== v1 仍可复现 ==", svc.provenance("C", "publisher", v1.version).value);
svc.store.close();
