import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(root, "content");
const publicDir = path.join(root, "public");
const stylesDir = path.join(root, "styles");

const toPosix = (value) => value.split(path.sep).join("/");
const stripExt = (value) => value.replace(/\.[^.]+$/, "");
const hash = (value) => crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
const ignoredRootDirs = new Set(["assets"]);
const cachedRemoteImages = new Set();
const htmlEscape = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function remoteImageName(src) {
  try {
    const url = new URL(src);
    if (!["http:", "https:"].includes(url.protocol)) return null;

    const ext = path.extname(url.pathname).slice(0, 12) || ".img";
    return `${hash(src)}${ext}`;
  } catch {
    return null;
  }
}

function resolveImageSrc(src, assetPrefix = ".") {
  const remoteName = remoteImageName(src);
  if (remoteName && cachedRemoteImages.has(remoteName)) {
    return `${assetPrefix}/assets/remote/${remoteName}`;
  }

  if (!remoteName && src.startsWith("assets/")) {
    return `${assetPrefix}/${src}`;
  }

  return src;
}

function parseFrontmatter(source) {
  if (!source.startsWith("---\n")) {
    return { data: {}, body: source };
  }

  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    return { data: {}, body: source };
  }

  const raw = source.slice(4, end).trim();
  const body = source.slice(end + 4).replace(/^\n/, "");
  const data = {};

  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  return { data, body };
}

function renderInline(markdown, options = {}) {
  const placeholders = [];
  const stash = (html) => {
    const token = `@@CODE${placeholders.length}@@`;
    placeholders.push(html);
    return token;
  };

  let text = markdown
    .replace(/`([^`]+)`/g, (_, code) => stash(`<code>${htmlEscape(code)}</code>`))
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
      const imageSrc = resolveImageSrc(src.trim(), options.assetPrefix);
      return stash(`<img src="${htmlEscape(imageSrc)}" alt="${htmlEscape(alt)}">`);
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
      const target = href.trim();
      if (/\s/.test(target)) return match;
      return stash(`<a href="${htmlEscape(target)}">${htmlEscape(label)}</a>`);
    });

  text = htmlEscape(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  placeholders.forEach((html, index) => {
    text = text.replace(`@@CODE${index}@@`, html);
  });
  return text;
}

function renderMarkdown(markdown, options = {}) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = null;
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let blockquote = [];
  let headingIndex = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "), options)}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };

  const flushBlockquote = () => {
    if (!blockquote.length) return;
    html.push(`<blockquote>${renderMarkdown(blockquote.join("\n"), options)}</blockquote>`);
    blockquote = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (inCode) {
        html.push(`<pre><code class="language-${htmlEscape(codeLang)}">${htmlEscape(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
        codeLang = "";
        codeLines = [];
      } else {
        flushParagraph();
        flushList();
        flushBlockquote();
        inCode = true;
        codeLang = fence[1].trim();
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushBlockquote();
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blockquote.push(quote[1]);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const level = heading[1].length;
      const plainHeading = plainInline(heading[2]);
      const id = options.anchorHeadings && level <= 3 && plainHeading ? ` id="${headingDomId(plainHeading, headingIndex)}"` : "";
      if (level <= 3 && plainHeading) headingIndex += 1;
      html.push(`<h${level}${id}>${renderInline(heading[2], options)}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushBlockquote();
      html.push("<hr>");
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushBlockquote();
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        flushList();
        html.push(`<${nextType}>`);
        listType = nextType;
      }
      html.push(`<li>${renderInline((unordered || ordered)[1], options)}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  if (inCode) {
    html.push(`<pre><code class="language-${htmlEscape(codeLang)}">${htmlEscape(codeLines.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  flushList();
  flushBlockquote();

  return html.join("\n");
}

async function ensureCleanPublic() {
  await fs.rm(publicDir, { recursive: true, force: true });
  await fs.mkdir(path.join(publicDir, "assets"), { recursive: true });
  await fs.mkdir(path.join(publicDir, "posts"), { recursive: true });
  await fs.mkdir(path.join(publicDir, "categories"), { recursive: true });
}

async function copyDir(from, to) {
  try {
    const entries = await fs.readdir(from, { withFileTypes: true });
    await fs.mkdir(to, { recursive: true });
    for (const entry of entries) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await copyDir(src, dest);
      } else {
        await fs.copyFile(src, dest);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function loadCachedRemoteImages() {
  try {
    const remoteDir = path.join(contentDir, "assets", "remote");
    const entries = await fs.readdir(remoteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) cachedRemoteImages.add(entry.name);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function findMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "assets") continue;
      files.push(...(await findMarkdownFiles(fullPath)));
    } else if (entry.name.endsWith(".md") && entry.name !== "profile.md") {
      files.push(fullPath);
    }
  }

  return files;
}

async function findContentDirectories(dir, baseParts = []) {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const directories = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (baseParts.length === 0 && ignoredRootDirs.has(entry.name)) continue;

    const relParts = [...baseParts, entry.name];
    const fullPath = path.join(dir, entry.name);
    directories.push(relParts);
    directories.push(...(await findContentDirectories(fullPath, relParts)));
  }

  return directories;
}

function excerptFrom(markdown) {
  const plain = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("```") && !line.startsWith("- "))
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#]/g, "");

  return plain.length > 120 ? `${plain.slice(0, 120)}...` : plain;
}

function removeDuplicateTitle(markdown, title) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const firstContent = lines.findIndex((line) => line.trim());
  if (firstContent === -1) return markdown;

  const match = lines[firstContent].match(/^#\s+(.+)$/);
  if (!match || match[1].trim() !== title) return markdown;

  lines.splice(firstContent, 1);
  return lines.join("\n").replace(/^\n+/, "");
}

function plainInline(markdown) {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();
}

function headingDomId(text, index) {
  return `h-${hash(`${index}-${text}`)}`;
}

function collectHeadings(markdown) {
  const headings = [];
  let index = 0;
  let inCode = false;

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (line.match(/^```/)) {
      inCode = !inCode;
      continue;
    }

    if (inCode) continue;

    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (!match) continue;

    const text = plainInline(match[2]);
    if (!text) continue;

    headings.push({
      level: match[1].length,
      text,
      id: headingDomId(text, index)
    });
    index += 1;
  }

  return headings;
}

function pageShell({ title, description = "", body, prefix = ".", nav = [] }) {
  const navHtml = nav
    .map(
      (item) =>
        `<a${item.active ? ' class="active" aria-current="page"' : ""} href="${item.href}">${htmlEscape(item.label)}</a>`
    )
    .join("");
  const brandMark = Array.from(site.name || "B")[0]?.toUpperCase() || "B";
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${htmlEscape(description)}">
  <title>${htmlEscape(title)}</title>
  <link rel="icon" href="${prefix}/${htmlEscape(site.avatar)}">
  <link rel="stylesheet" href="${prefix}/assets/site.css">
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="${prefix}/index.html">
        <span class="brand-mark">${htmlEscape(brandMark)}</span>
        <span class="brand-text">
          <span class="brand-name">${htmlEscape(site.name)}</span>
          <span class="brand-subtitle">${htmlEscape(site.headline)}</span>
        </span>
      </a>
      <nav class="nav" aria-label="主导航">${navHtml}</nav>
    </div>
  </header>
  ${body}
  <footer class="footer">
    <span>© ${year} ${htmlEscape(site.name)}</span>
    <span>Learning in public, one note at a time.</span>
  </footer>
</body>
</html>`;
}

function tagsHtml(tags = []) {
  return tags.map((tag) => `<span class="tag">${htmlEscape(tag)}</span>`).join("");
}

function ensureCategory(categories, parts) {
  const key = parts.join("/");
  if (!key) return null;

  if (!categories.has(key)) {
    categories.set(key, {
      id: hash(key),
      label: parts.join(" / "),
      parts,
      posts: []
    });
  }

  return categories.get(key);
}

function categoryDisplayName(category) {
  return category.parts.at(-1) || "全部文章";
}

function countWords(markdown) {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  const cjk = plain.match(/[\p{Script=Han}]/gu)?.length || 0;
  const latin = plain.replace(/[\p{Script=Han}]/gu, " ").match(/[\p{L}\p{N}]+/gu)?.length || 0;
  return cjk + latin;
}

function formatDate(dateString) {
  if (!dateString) return "—";
  const date = new Date(`${dateString}T00:00:00Z`);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatCompactNumber(value) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}w`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function icon(name) {
  const paths = {
    location: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name] || paths.arrow}</svg>`;
}

function buildContributionGraph(posts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const start = new Date(end);
  start.setDate(start.getDate() - 52 * 7 - 6);

  const activity = new Map();
  for (const post of posts) {
    if (!post.date) continue;
    activity.set(post.date, (activity.get(post.date) || 0) + 1);
  }

  const cells = [];
  const months = [];
  let previousMonth = -1;
  for (let i = 0; i < 53 * 7; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const key = date.toISOString().slice(0, 10);
    const count = activity.get(key) || 0;
    const future = date > today;
    const level = future ? 0 : Math.min(4, count);
    cells.push(
      `<span class="contribution-cell level-${level}${future ? " future" : ""}" title="${key}: ${count} post${count === 1 ? "" : "s"}"></span>`
    );

    if (date.getMonth() !== previousMonth && date.getDate() <= 7) {
      months.push({
        label: new Intl.DateTimeFormat("en", { month: "short" }).format(date),
        column: Math.floor(i / 7) + 1
      });
      previousMonth = date.getMonth();
    }
  }

  const monthLabels = months
    .map((month) => `<span style="grid-column:${month.column}">${month.label}</span>`)
    .join("");
  const total = [...activity.values()].reduce((sum, value) => sum + value, 0);
  return `<div class="contribution-wrap" aria-label="Blog contributions over the last year">
    <div class="contribution-months">${monthLabels}</div>
    <div class="contribution-grid">${cells.join("")}</div>
    <div class="contribution-caption">
      <span>${total} post${total === 1 ? "" : "s"} published in the last year</span>
      <span class="contribution-legend">Less <i class="level-0"></i><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><i class="level-4"></i> More</span>
    </div>
  </div>`;
}

let site = {};

async function main() {
  await ensureCleanPublic();
  await copyDir(path.join(contentDir, "assets"), path.join(publicDir, "assets"));
  await fs.copyFile(path.join(stylesDir, "site.css"), path.join(publicDir, "assets", "site.css"));
  await loadCachedRemoteImages();

  site = JSON.parse(await fs.readFile(path.join(contentDir, "site.json"), "utf8"));

  const directoryParts = await findContentDirectories(contentDir);
  const declaredTopDirectories = directoryParts.filter((parts) => parts.length === 1).map((parts) => parts[0]);
  const declaredCategoryDirectories = directoryParts.filter(
    (parts) =>
      parts.length > 1 &&
      !directoryParts.some(
        (candidate) =>
          candidate.length > parts.length && parts.every((part, index) => candidate[index] === part)
      )
  );

  const files = await findMarkdownFiles(contentDir);
  const posts = [];
  for (const file of files) {
    const rel = toPosix(path.relative(contentDir, file));
    const source = await fs.readFile(file, "utf8");
    const parsed = parseFrontmatter(source);
    const categoryParts = rel.split("/").slice(0, -1);
    const effectiveCategoryParts = categoryParts.length ? categoryParts : ["未分类"];
    const slug = hash(rel);
    const title = parsed.data.title || stripExt(path.basename(file));
    posts.push({
      rel,
      slug,
      title,
      date: parsed.data.date || "",
      tags: Array.isArray(parsed.data.tags) ? parsed.data.tags : [],
      summary: parsed.data.summary || excerptFrom(parsed.body),
      body: parsed.body,
      wordCount: countWords(parsed.body),
      categoryParts: effectiveCategoryParts,
      categoryLabel: effectiveCategoryParts.join(" / "),
      categoryId: hash(effectiveCategoryParts.join("/"))
    });
  }

  posts.sort((a, b) => String(b.date).localeCompare(String(a.date), "zh-CN") || a.title.localeCompare(b.title, "zh-CN"));

  const categories = new Map();
  for (const parts of declaredCategoryDirectories) {
    ensureCategory(categories, parts);
  }

  for (const post of posts) {
    ensureCategory(categories, post.categoryParts).posts.push(post);
  }

  const linkHtml = (site.links || [])
    .map(
      (link) =>
        `<a class="link-pill" href="${htmlEscape(link.url)}" target="_blank" rel="noreferrer"><span>${htmlEscape(link.label)}</span>${icon("arrow")}</a>`
    )
    .join("");

  const topNames = new Set(declaredTopDirectories);
  for (const category of categories.values()) {
    topNames.add(category.parts[0] || "未分类");
  }

  const groupedByTop = new Map([...topNames].map((top) => [top, []]));
  for (const category of categories.values()) {
    const top = category.parts[0] || "未分类";
    if (!groupedByTop.has(top)) groupedByTop.set(top, []);
    groupedByTop.get(top).push(category);
  }

  const categoryOrder = new Map((site.categoryOrder || []).map((key, index) => [key, index]));
  const topOrder = new Map(
    [...new Set((site.categoryOrder || []).map((key) => key.split("/")[0]).filter(Boolean))].map((key, index) => [key, index])
  );
  const orderedGroups = [...groupedByTop.entries()]
    .sort(([a], [b]) => (topOrder.get(a) ?? 999) - (topOrder.get(b) ?? 999) || a.localeCompare(b, "zh-CN"))
    .map(([top, group]) => [
      top,
      group.sort((a, b) => {
        const aKey = a.parts.join("/");
        const bKey = b.parts.join("/");
        return (categoryOrder.get(aKey) ?? 999) - (categoryOrder.get(bKey) ?? 999) || a.label.localeCompare(b.label, "zh-CN");
      })
    ]);
  const orderedCategories = orderedGroups.flatMap(([, group]) => group);
  const sectionsHtml = orderedGroups
    .map(([top, group]) => {
      const cards = group
        .map((category, index) => {
          const list = category.posts
            .slice(0, 4)
            .map(
              (post) =>
                `<li><a href="posts/${post.slug}.html"><span>${htmlEscape(post.title)}</span><time class="date">${htmlEscape(post.date)}</time></a></li>`
            )
            .join("");
          return `<article class="category-card">
  <span class="category-index">${String(index + 1).padStart(2, "0")}</span>
  <div class="category-top">
    <h3 class="category-title"><a href="categories/${category.id}.html">${htmlEscape(categoryDisplayName(category))}</a></h3>
    <span class="count">${category.posts.length} 篇</span>
  </div>
  <ul class="article-list">${list || '<li class="empty">暂无文章</li>'}</ul>
</article>`;
        })
        .join("\n");
      const content =
        cards ||
        `<div class="empty-state">
  <strong>暂无分类</strong>
  <span>在 content/${htmlEscape(top)} 下新建子文件夹或 Markdown 文章后，这里会自动出现对应板块。</span>
</div>`;

      return `<section id="${hash(top)}">
  <div class="section-heading">
    <h2>${htmlEscape(top)}</h2>
    <p>${group.reduce((sum, category) => sum + category.posts.length, 0)} 篇文章</p>
  </div>
  <div class="category-grid">${content}</div>
</section>`;
    })
    .join("\n");

  const latestHtml = posts
    .slice(0, 3)
    .map(
      (post) => `<a class="feature-card" href="posts/${post.slug}.html">
  <span class="feature-category">${htmlEscape(post.categoryLabel)}</span>
  <h3>${htmlEscape(post.title)}</h3>
  <p>${htmlEscape(post.summary)}</p>
  <div class="meta"><time class="date">${htmlEscape(post.date)}</time>${tagsHtml(post.tags.slice(0, 2))}</div>
</a>`
    )
    .join("");

  const latestDate = posts.find((post) => post.date)?.date || "";
  const firstDate = [...posts].reverse().find((post) => post.date)?.date || latestDate;
  const today = new Date();
  const firstDay = firstDate ? new Date(`${firstDate}T00:00:00`) : today;
  const daysOnline = Math.max(1, Math.floor((today - firstDay) / 86400000) + 1);
  const totalWords = posts.reduce((sum, post) => sum + post.wordCount, 0);
  const educationHtml = (site.education || [])
    .map(
      (education) => `<article class="education-card">
        <div>
          <h3>${htmlEscape(education.school)}</h3>
          <p>${htmlEscape(education.degree)}</p>
          ${education.description ? `<span>${htmlEscape(education.description)}</span>` : ""}
        </div>
        <time>${htmlEscape(education.period)}</time>
      </article>`
    )
    .join("");
  const interestsHtml = (site.researchInterests || []).map((interest) => `<span>${htmlEscape(interest)}</span>`).join("");

  const index = pageShell({
    title: `${site.name} — ${site.headline}`,
    description: site.bio,
    prefix: ".",
    nav: [
      { label: "Home", href: "index.html", active: true },
      { label: "Blog", href: "blog.html" }
    ],
    body: `<main class="page home-page">
  <div class="academic-layout">
    <aside class="profile-sidebar">
      <div class="profile-photo-wrap">
        <img class="profile-photo" src="${htmlEscape(site.avatar)}" alt="${htmlEscape(site.name)} 的头像">
        <span class="availability-dot" aria-label="Currently active"></span>
      </div>
      <div class="sidebar-identity">
        <h1>${htmlEscape(site.name)}</h1>
        <p class="profile-role">${htmlEscape(site.headline)}</p>
        <p class="profile-location">${icon("location")} ${htmlEscape(site.location || "")}</p>
      </div>
      <div class="sidebar-links" aria-label="Contact links">${linkHtml}</div>
      <section class="research-card">
        <h2>Research Interests</h2>
        <div class="interest-list" aria-label="Research interests">${interestsHtml}</div>
      </section>
    </aside>

    <div class="profile-main">
      <section class="academic-section about-section">
        <p class="section-kicker">Introduction</p>
        <h2>About</h2>
        <p class="about-copy">${htmlEscape(site.bio)}</p>
      </section>

      <section class="academic-section">
        <p class="section-kicker">Background</p>
        <h2>Education</h2>
        <div class="education-list">${educationHtml}</div>
      </section>

      <section class="academic-section statistics-section">
        <p class="section-kicker">Writing activity</p>
        <h2>Statistics</h2>
        <div class="stat-cards">
          <article>${icon("clock")}<strong>${daysOnline}</strong><span>Days Online</span></article>
          <article>${icon("calendar")}<strong class="stat-date">${htmlEscape(formatDate(latestDate))}</strong><span>Last Updated</span></article>
          <article>${icon("file")}<strong>${htmlEscape(formatCompactNumber(totalWords))}</strong><span>Total Words</span></article>
        </div>
        <div class="post-total"><span>Total Posts</span><strong>${posts.length}</strong></div>
        ${buildContributionGraph(posts)}
      </section>
    </div>
  </div>
</main>`
  });

  await fs.writeFile(path.join(publicDir, "index.html"), index);

  const blogPage = pageShell({
    title: `Blog — ${site.name}`,
    description: `Notes on research, engineering, and things learned along the way by ${site.name}.`,
    prefix: ".",
    nav: [
      { label: "Home", href: "index.html" },
      { label: "Blog", href: "blog.html", active: true }
    ],
    body: `<main class="page blog-page">
  <header class="blog-hero">
    <p class="eyebrow">Notes & field records</p>
    <div>
      <h1>Blog</h1>
      <p>Research notes, engineering practice, and ideas worth keeping.</p>
    </div>
    <span>${posts.length} posts · ${orderedGroups.length} topics</span>
  </header>
  <section class="home-section latest-section">
    <div class="section-heading">
      <div><p class="section-kicker">Latest</p><h2>Recently published</h2></div>
      <p>${htmlEscape(formatDate(latestDate))}</p>
    </div>
    <div class="feature-grid">${latestHtml}</div>
  </section>
  <section class="blog-archive">
    <div class="section-heading">
      <div><p class="section-kicker">Archive</p><h2>Browse by topic</h2></div>
      <p>${categories.size} categories</p>
    </div>
    ${sectionsHtml}
  </section>
</main>`
  });

  await fs.writeFile(path.join(publicDir, "blog.html"), blogPage);

  for (const category of orderedCategories) {
    const articles = category.posts
      .map(
        (post) => `<a class="article-card" href="../posts/${post.slug}.html">
  <h2>${htmlEscape(post.title)}</h2>
  <p>${htmlEscape(post.summary)}</p>
  <div class="meta"><time class="date">${htmlEscape(post.date)}</time>${tagsHtml(post.tags)}</div>
</a>`
      )
      .join("");

    const categoryPage = pageShell({
      title: `${category.label} - ${site.name}`,
      description: `${category.label} 下的文章列表`,
      prefix: "..",
      nav: [
        { label: "Home", href: "../index.html" },
        { label: "Blog", href: "../blog.html", active: true }
      ],
      body: `<main class="page listing-page">
  <header class="listing-hero">
    <p class="crumbs"><a href="../blog.html">Blog</a> / ${htmlEscape(category.label)}</p>
    <p class="section-kicker">${htmlEscape(category.parts[0] || "Archive")}</p>
    <h1>${htmlEscape(categoryDisplayName(category))}</h1>
    <p>${htmlEscape(category.label)} 下共有 ${category.posts.length} 篇文章。</p>
  </header>
  <div class="article-grid">${articles || '<p class="empty">暂无文章</p>'}</div>
</main>`
    });
    await fs.writeFile(path.join(publicDir, "categories", `${category.id}.html`), categoryPage);
  }

  for (const post of posts) {
    const articleBody = removeDuplicateTitle(post.body, post.title);
    const toc = collectHeadings(articleBody);
    const tocHtml =
      toc.length >= 4
        ? `<aside class="toc" aria-label="文章目录">
    <p>目录</p>
    <ol>${toc
      .map((heading) => `<li class="toc-level-${heading.level}"><a href="#${heading.id}">${htmlEscape(heading.text)}</a></li>`)
      .join("")}</ol>
  </aside>`
        : "";
    const articlePage = pageShell({
      title: `${post.title} - ${site.name}`,
      description: post.summary,
      prefix: "..",
      nav: [
        { label: "Home", href: "../index.html" },
        { label: "Blog", href: "../blog.html", active: true }
      ],
      body: `<main class="page article-page">
  <p class="crumbs"><a href="../blog.html">Blog</a> / <a href="../categories/${post.categoryId}.html">${htmlEscape(post.categoryLabel)}</a></p>
  <div class="article-layout${tocHtml ? " has-toc" : ""}">
    <article class="article-shell">
      <header class="article-header">
        <p class="section-kicker">${htmlEscape(post.categoryLabel)}</p>
        <h1>${htmlEscape(post.title)}</h1>
        <p class="article-summary">${htmlEscape(post.summary)}</p>
        <div class="meta"><time class="date">${htmlEscape(post.date)}</time>${tagsHtml(post.tags)}</div>
      </header>
      <div class="content">${renderMarkdown(articleBody, { assetPrefix: "..", anchorHeadings: true })}</div>
    </article>
    ${tocHtml}
  </div>
</main>`
    });
    await fs.writeFile(path.join(publicDir, "posts", `${post.slug}.html`), articlePage);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    posts: posts.map((post) => ({
      title: post.title,
      source: post.rel,
      output: `posts/${post.slug}.html`,
      category: post.categoryLabel
    }))
  };
  await fs.writeFile(path.join(publicDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Generated ${posts.length} posts and ${categories.size} categories in public/`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
