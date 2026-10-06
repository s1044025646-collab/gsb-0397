# 受限 BibTeX 宏展开与跨条目字段继承解释后端

TypeScript + Node.js + SQLite（`node:sqlite`，零原生依赖、零运行时第三方依赖）实现的本地后端，只做 **API 与 CLI**。不排版参考文献、不执行 TeX、不联网检索 DOI、不做文章推荐，也未使用任何现成 BibTeX 解析器或 `eval`。

## 功能与语义（受限，明确声明）

- 输入 UTF-8 文本，支持 `@string` 与 `book / article / inproceedings / proceedings / misc` 条目；其他 `@` 指令（如 `@preamble`、`@comment`、未知类型）**明确拒绝**，不会跳过后声称完整导入。
- 手写解析器逐字符处理：花括号嵌套、引号字符串、十进制字面量、宏引用、`#` 连接表达式。被定界字符串内部的逗号、等号、`#` 是普通内容，绝不按逗号简单切分。
- 外层定界符不属于值；内部用于保护大小写的花括号与反斜杠文本**原样保留**（如 `{中文 {API}}` → `中文 {API}`），不当 HTML/TeX 执行。
- 语法错误带源区间（`span: {start, end}`，UTF-16 码元半开区间）。
- 宏名、字段名按 ASCII 大小写不敏感；条目键**区分大小写**。规范化后重复的宏/字段/条目一律拒绝。
- 宏允许前向引用，按整个文献库版本求值，定义顺序不影响结果；缺失宏与宏循环返回**依赖路径**。
- 空字符串（`{}` / `""`）是合法显式值，可覆盖继承来的字段。
- 预算控制：花括号嵌套深度（默认 64）、宏展开深度（默认 100）、展开字符数（默认 1,000,000）、宏依赖数量（默认 10,000）。预算耗尽**明确失败**，不返回截断的“成功”字段。可在导入时通过 `options` 覆盖：`{maxNestDepth, maxExpandDepth, maxExpandChars, maxDependencies}`。
- **crossref 简化语义（公开声明，不兼容所有传统 BibTeX 样式行为）**：先展开 crossref 值作为父条目键（单个未定义裸标识符按字面键处理）；子条目显式字段覆盖父条目同名有效字段；其余普通字段逐层继承；键、类型、crossref 本身不向下继承；不做 `booktitle` 等隐含改名。支持多层父链、缺失父条目与循环检测；每个最终字段附实际来源条目 `source` 与继承路径 `path`。
- 查询一个子条目是**纯只读**，不会修改父条目字段。

## 版本与持久化

- SQLite 单库原子保存：原文、语法结构（表达式 AST）、规则版本（`restricted-bibtex/1`）、展开结果与诊断，全部在一个事务内写入。
- 每次导入创建新版本；修改父条目或宏即产生新版本，旧版本报告保持可复现。
- 失败导入保存诊断（可查询），但**不会覆盖**当前已通过的库版本。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 仅开发依赖 typescript + @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API（默认 data/bibtex.db，自动选空闲端口）
npm run demo       # 端到端演示：导入→展开→来源链→改父→比较→复现旧版
```

CLI（`node dist/src/cli.js [--db 数据文件] <命令>`）：

```
serve [--port N]                    启动 HTTP API（端口缺省自动选空闲）
import <文件.bib>                   导入并创建新版本
versions                            列出所有版本与当前版本
list [--version N]                  列出条目（含原始表达式）
expand <键> [字段] [--version N]    展开字段（含来源链）
provenance <键> <字段> [--version N]
diagnostics <版本N>
diff <版本A> <版本B>
export [--version N]                导出结构化 JSON（原始表达式/展开值/来源分离）
```

## HTTP API（默认绑定 127.0.0.1，端口 0 表示自动选空闲）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/versions` | 导入，体：`{"text": "...", "options": {...}}`；成功 201，失败 422 附诊断 |
| GET | `/versions` | 版本列表与当前版本 |
| GET | `/entries?version=N` | 条目列表 |
| GET | `/entries/{key}?version=N` | 条目全部有效字段（展开值+来源链） |
| GET | `/entries/{key}/{field}?version=N` | 单字段来源链 |
| GET | `/diagnostics?version=N` | 诊断（失败版本也可查） |
| GET | `/diff?from=A&to=B` | 比较两个已通过版本 |
| GET | `/export?version=N` | 结构化导出 |

错误响应统一为 `{"error": {"code", "message", "span"?, "path"?, "entry"?, "field"?}}`。

## 错误码

`PARSE_ERROR`、`UNSUPPORTED_DIRECTIVE`、`DUPLICATE_MACRO`、`DUPLICATE_FIELD`、`DUPLICATE_ENTRY`、`UNDEFINED_MACRO`、`MACRO_CYCLE`、`CROSSREF_MISSING`、`CROSSREF_CYCLE`、`DEPTH_EXCEEDED`、`BUDGET_EXCEEDED`、`VALIDATION_ERROR`、`NOT_FOUND`、`INTERNAL`。

## 演示场景（已测）

宏 `press` 展开为“青山”；父条目 `P` 的 `publisher = press`、`year = 2026`；子条目 `C` 的 `crossref = P`、`year = 2027`：继承出版社“青山”（`source: "P"`, `path: ["C","P"]`），年份保留 2027。`title = {中文 {API}}` 的内层花括号保留。

## 限制

- 受限子集：不支持 `@preamble`、嵌套注释、括号定界内的引号转义等冷门语法；crossref 为上述简化语义，不宣称兼容所有传统 BibTeX 样式行为。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常。
- 仅监听 `127.0.0.1`，无鉴权，面向本机使用。
