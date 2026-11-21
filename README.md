# Sundy Li · 个人主页

新站是纯静态 HTML、CSS 和 JavaScript，不需要 Hugo、Node.js 或其他构建工具。只发布 `site/`，旧博客的 Hugo 源文件保留在仓库中，不会出现在新站。默认首页 `/` 为英文，中文版位于 `/zh/`。旧的 `/en/` 和 `/about/` 分别跳转到对应语言的首页。

## 预览和修改

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

打开 <http://127.0.0.1:4173/>。更新公开资料时，只编辑 `site/data/profile.json`，然后运行 `python3 scripts/sync_profile.py`，并一起提交中英文页面的更新。页面里 `profile:` 注释之间的内容由脚本生成，即使禁用 JavaScript 也能看到。部署前会检查页面内容是否与 JSON 一致。

## SQL Playground

中英文首页复用 `site/assets/playground.js` 和 `site/assets/sql-engine.js`。首次运行时才从 jsDelivr 加载固定版本的 DuckDB-Wasm，并在浏览器的 Worker 里执行查询；没有 SQL 服务端。内存中的 `profile` 表直接读取同一个 `site/data/profile.json`，字段名固定为英文，资料按当前页面语言加载。运行 `DESCRIBE profile;` 查看字段，或执行 `SELECT * FROM profile;` 查看全部公开资料。重置会清空临时改动。部署时需允许浏览器访问 jsDelivr。

## 部署

首次上线需在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**，替代旧的 `gh-pages` 分支发布方式。之后 `main` 的更新会通过 `.github/workflows/gh-pages.yml` 发布到 <https://sundy-li.github.io/>，也可在 Actions 页面从 `main` 手动运行。

如果继续使用 Vercel，`vercel.json` 也配置为直接发布 `site/`，不需要构建命令。
