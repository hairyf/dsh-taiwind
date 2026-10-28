import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Scanner } from "@tailwindcss/oxide";
import postcss from "postcss";
import { compile } from "tailwindcss";
//#region src/compiler.ts
const configNamePattern = /^(?:tailwind|taiwind)\.config\.[^.]+$/;
const configPattern = /^(?:tailwind|taiwind)\.config\.[cm]?js$/;
const bundlePattern = /\.[cm]?js$/;
const nodeRequire = createRequire(import.meta.url);
let cached;
async function nativeModule(configPath, root) {
	const extension = extname(configPath);
	if (extension === ".mjs") return true;
	if (extension === ".cjs") return false;
	return JSON.parse(await readFile(join(root, "package.json"), "utf8")).type === "module";
}
async function loadModule(configPath, rawConfig, root) {
	if (await nativeModule(configPath, root)) {
		const url = pathToFileURL(configPath);
		url.search = `?v=${createHash("sha256").update(rawConfig).digest("hex").slice(0, 16)}`;
		const loaded = await import(url.href);
		return loaded.default ?? loaded;
	}
	for (const key of Object.keys(nodeRequire.cache)) if (key.startsWith(`${root}${sep}`)) delete nodeRequire.cache[key];
	const loaded = nodeRequire(configPath);
	return loaded?.default ?? loaded;
}
function isObject(value) {
	return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function staticData(value, location) {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map((item, index) => staticData(item, `${location}[${index}]`));
	if (isObject(value)) {
		const output = Object.create(null);
		for (const [key, item] of Object.entries(value)) {
			if ([
				"__proto__",
				"constructor",
				"prototype"
			].includes(key)) throw new Error(`${location}.${key}: unsupported configuration key`);
			output[key] = staticData(item, `${location}.${key}`);
		}
		return output;
	}
	throw new Error(`${location}: only static JSON-compatible configuration values are supported`);
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}
function validateConfig(value, owner) {
	if (!isObject(value)) throw new Error(`${owner}: Tailwind config must export an object`);
	for (const key of Object.keys(value)) if (![
		"theme",
		"darkMode",
		"prefix",
		"important"
	].includes(key)) throw new Error(`${owner}: unsupported Tailwind configuration option "${key}"; supported: theme.extend, darkMode, prefix, important`);
	const config = staticData(value, owner);
	if ("theme" in config) {
		if (!isObject(config.theme) || Object.keys(config.theme).some((key) => key !== "extend")) throw new Error(`${owner}: only theme.extend is supported; direct theme replacement is not supported`);
		if ("extend" in config.theme) {
			if (!isObject(config.theme.extend)) throw new Error(`${owner}: theme.extend must be an object`);
			for (const [section, values] of Object.entries(config.theme.extend)) if (!isObject(values)) throw new Error(`${owner}: theme.extend.${section} must be a static object`);
		}
	}
	if ("darkMode" in config) {
		const mode = config.darkMode;
		const validVariant = Array.isArray(mode) && mode[0] === "variant" && (typeof mode[1] === "string" || Array.isArray(mode[1]) && mode[1].every((item) => typeof item === "string"));
		const validSelector = Array.isArray(mode) && ["class", "selector"].includes(mode[0]) && typeof mode[1] === "string";
		if (!(mode === false || [
			"media",
			"class",
			"selector"
		].includes(mode) || Array.isArray(mode) && mode.length === 2 && (validVariant || validSelector))) throw new Error(`${owner}: invalid darkMode strategy`);
	}
	if ("prefix" in config && (typeof config.prefix !== "string" || !/^[a-z]+$/.test(config.prefix))) throw new Error(`${owner}: prefix must contain lowercase letters only (Tailwind v4 prefix syntax)`);
	if ("important" in config && typeof config.important !== "boolean" && (typeof config.important !== "string" || !config.important.trim())) throw new Error(`${owner}: important must be a boolean or a nonempty selector`);
	return config;
}
function mergeValues(target, incoming, owner, owners, path = "theme.extend") {
	for (const [key, value] of Object.entries(incoming)) {
		const location = `${path}.${key}`;
		if (Object.hasOwn(target, key)) {
			if (isObject(target[key]) && isObject(value)) mergeValues(target[key], value, owner, owners, location);
			else if (canonical(target[key]) !== canonical(value)) throw new Error(`Tailwind config conflict at ${location}: ${owners.get(location)} and ${owner}`);
		} else {
			target[key] = isObject(value) ? Object.create(null) : value;
			owners.set(location, owner);
			if (isObject(value)) mergeValues(target[key], value, owner, owners, location);
		}
	}
}
function checkAliases(extend, owner, aliases) {
	for (const [section, values] of Object.entries(extend)) {
		const visit = (value, path) => {
			if (isObject(value)) {
				for (const [key, item] of Object.entries(value)) visit(item, key === "DEFAULT" ? path : [...path, key]);
				return;
			}
			const key = `${section}.${path.join("-")}`;
			const serialized = canonical(value);
			const previous = aliases.get(key);
			if (previous && previous.value !== serialized) throw new Error(`Tailwind theme token conflict at ${key}: ${previous.owner} and ${owner}`);
			aliases.set(key, {
				value: serialized,
				owner
			});
		};
		visit(values, []);
	}
}
async function packageRoot(path, id) {
	for (let directory = dirname(path);;) {
		try {
			if (JSON.parse(await readFile(join(directory, "package.json"), "utf8")).name === id) return directory;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`${id}: cannot find an owning package.json for ${path}`);
		directory = parent;
	}
}
async function bundles(directory) {
	const files = [];
	for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		if (item.name === "node_modules" || item.name === "archive" || item.isSymbolicLink()) continue;
		const path = join(directory, item.name);
		if (item.isDirectory()) files.push(...await bundles(path));
		else if (item.isFile() && bundlePattern.test(item.name)) files.push(path);
	}
	return files;
}
async function cssEntry(root, clientDirectory) {
	for (const directory of /* @__PURE__ */ new Set([root, clientDirectory])) {
		const entry = (await readdir(directory, { withFileTypes: true })).find((item) => item.name === "main.css");
		if (entry) {
			if (!entry.isFile()) throw new Error(`${directory}: main.css must be a regular file`);
			return join(directory, entry.name);
		}
	}
	const found = [];
	const visit = async (directory) => {
		for (const item of await readdir(directory, { withFileTypes: true })) {
			if ([
				"node_modules",
				"archive",
				".git"
			].includes(item.name) || item.isSymbolicLink()) continue;
			const path = join(directory, item.name);
			if (item.isDirectory()) await visit(path);
			else if (item.isFile() && item.name === "main.css") found.push(path);
		}
	};
	await visit(root);
	if (found.length > 1) throw new Error(`${root}: multiple main.css entries found: ${found.sort().join(", ")}`);
	return found[0];
}
async function compilePlugins(entries) {
	const hash = createHash("sha256");
	const sources = [];
	const extend = Object.create(null);
	const merged = { theme: { extend } };
	const owners = /* @__PURE__ */ new Map();
	const aliases = /* @__PURE__ */ new Map();
	const seen = /* @__PURE__ */ new Set();
	const stylesheets = /* @__PURE__ */ new Map();
	const cssImports = [];
	const cssDefinitions = /* @__PURE__ */ new Map();
	const configsSeen = /* @__PURE__ */ new Set();
	const setGlobal = (key, value, owner) => {
		if (Object.hasOwn(merged, key) && canonical(merged[key]) !== canonical(value)) throw new Error(`Tailwind global configuration conflict at ${key}: ${owners.get(key)} and ${owner}`);
		merged[key] = value;
		owners.set(key, owner);
	};
	const loadConfig = async (configPath, owner, root) => {
		configPath = await realpath(configPath);
		if (configsSeen.has(configPath)) return;
		configsSeen.add(configPath);
		const rawConfig = await readFile(configPath, "utf8");
		let loaded;
		try {
			loaded = await loadModule(configPath, rawConfig, root);
		} catch (error) {
			throw new Error(`${owner}: failed to load ${configPath}`, { cause: error });
		}
		const config = validateConfig(loaded, owner);
		hash.update(JSON.stringify([
			configPath,
			rawConfig,
			canonical(config)
		]));
		const configExtend = config.theme?.extend;
		if (configExtend) {
			checkAliases(configExtend, owner, aliases);
			mergeValues(extend, configExtend, owner, owners);
		}
		for (const key of [
			"darkMode",
			"prefix",
			"important"
		]) if (Object.hasOwn(config, key)) setGlobal(key, config[key], owner);
	};
	const checkDefinition = (key, value, owner) => {
		const previous = cssDefinitions.get(key);
		if (previous && previous.owner !== owner && previous.value !== value) throw new Error(`Tailwind CSS conflict at ${key}: ${previous.owner} and ${owner}`);
		cssDefinitions.set(key, {
			value,
			owner
		});
	};
	const loadCss = async (filename, root, owner, ancestors = []) => {
		const path = await realpath(filename);
		const local = relative(root, path);
		if (local === ".." || local.startsWith("../") || local.startsWith("..\\") || isAbsolute(local)) throw new Error(`${owner}: CSS dependency is outside its package: ${filename}`);
		if (ancestors.includes(path)) throw new Error(`${owner}: circular CSS import: ${[...ancestors, path].join(" -> ")}`);
		if (stylesheets.has(path)) return path;
		const content = await readFile(path, "utf8");
		hash.update(JSON.stringify([path, content]));
		const ast = postcss.parse(content, { from: path });
		const directives = [];
		ast.walkAtRules((rule) => {
			directives.push(rule);
		});
		for (const rule of directives) {
			if ([
				"import",
				"reference",
				"tailwind"
			].includes(rule.name) && /\bsource\((?!none\))/.test(rule.params.replace(/^(?:"[^"]*"|'[^']*')/, ""))) throw new Error(`${owner}: source(...) directory scanning is not supported; file candidates come from client bundles`);
			if ([
				"import",
				"reference",
				"config"
			].includes(rule.name)) {
				const match = /^(?:"([^"\\]+)"|'([^'\\]+)')(.*)$/s.exec(rule.params);
				if (!match) throw new Error(`${owner}: ${path}: @${rule.name} requires a quoted local path`);
				const id = match[1] ?? match[2];
				const options = match[3].trim();
				if (rule.name === "config") {
					if (options || !id.startsWith(".")) throw new Error(`${owner}: @config requires a relative path without options`);
					await loadConfig(resolve(dirname(path), id), owner, root);
					rule.remove();
				} else if (/^tailwindcss(?:\/(?:index|theme|utilities|preflight)(?:\.css)?)?$/.test(id)) {
					const rest = options.replace(/\blayer\((?:theme|base|utilities)\)|\bsource\(none\)/g, "").trim();
					const prefix = /\bprefix\(([a-z]+)\)/.exec(rest);
					if (prefix) setGlobal("prefix", prefix[1], owner);
					if (/\bimportant\b/.test(rest)) setGlobal("important", true, owner);
					if (rest.replace(/\bprefix\([a-z]+\)|\bimportant\b/g, "").trim()) throw new Error(`${owner}: unsupported Tailwind import options: ${options}`);
					rule.remove();
				} else {
					if (!id.startsWith(".") || extname(id) !== ".css") throw new Error(`${owner}: only relative .css imports and tailwindcss imports are supported: ${id}`);
					const imported = await loadCss(resolve(dirname(path), id), root, owner, [...ancestors, path]);
					rule.params = `${JSON.stringify(imported.replaceAll("\\", "/"))}${options ? ` ${options}` : ""}`;
				}
			} else if (rule.name === "plugin") throw new Error(`${owner}: @plugin is not supported; use CSS @utility instead`);
			else if (rule.name === "source" && !/^(?:not\s+)?inline\(/.test(rule.params)) throw new Error(`${owner}: only @source inline(...) is supported; file candidates come from client bundles`);
			else if (rule.name === "theme") rule.each((node) => {
				if (node.type === "decl") checkDefinition(node.prop, JSON.stringify([
					rule.params,
					node.value,
					node.important
				]), owner);
			});
			else if (["utility", "custom-variant"].includes(rule.name)) checkDefinition(`@${rule.name} ${rule.params.split(/[\s(]/)[0]}`, rule.toString(), owner);
		}
		stylesheets.set(path, ast.toString());
		return path;
	};
	for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path))) {
		const path = await realpath(resolve(entry.path));
		const root = await packageRoot(path, entry.id);
		hash.update(JSON.stringify([entry.id, path]));
		for (const file of await bundles(dirname(path))) {
			if (seen.has(file)) continue;
			seen.add(file);
			const content = await readFile(file, "utf8");
			hash.update(JSON.stringify([file, content]));
			sources.push({
				content,
				extension: extname(file).slice(1)
			});
		}
		const stylesheet = await cssEntry(root, dirname(path));
		if (stylesheet) {
			cssImports.push(await loadCss(stylesheet, root, entry.id));
			continue;
		}
		const configs = (await readdir(root, { withFileTypes: true })).filter((item) => configNamePattern.test(item.name));
		if (configs.length > 1) throw new Error(`${entry.id}: multiple Tailwind configs found: ${configs.map((item) => item.name).join(", ")}`);
		if (!configs.length) continue;
		if (!configs[0].isFile()) throw new Error(`${entry.id}: Tailwind config must be a regular file`);
		if (!configPattern.test(configs[0].name)) throw new Error(`${entry.id}: unsupported Tailwind config ${configs[0].name}; use .js, .cjs or .mjs`);
		await loadConfig(join(root, configs[0].name), entry.id, root);
	}
	if (!Object.hasOwn(merged, "darkMode")) merged.darkMode = "class";
	const theme = await readFile(new URL(import.meta.resolve("tailwindcss/theme.css")), "utf8");
	const utilities = await readFile(new URL(import.meta.resolve("tailwindcss/utilities.css")), "utf8");
	hash.update(JSON.stringify([theme, utilities]));
	const digest = hash.digest("hex");
	if (cached?.hash === digest) return cached.css;
	const candidates = new Scanner({}).scanFiles(sources);
	const compiler = await compile(`@layer theme, base, components, utilities;\n@layer theme {\n${theme}\n}\n${cssImports.map((path) => `@import ${JSON.stringify(path.replaceAll("\\", "/"))};`).join("\n")}\n@layer utilities {\n${utilities}\n}\n@config "dsh-taiwind:merged";`, {
		loadModule: async (id) => {
			if (id !== "dsh-taiwind:merged") throw new Error(`Unexpected Tailwind module: ${id}`);
			return {
				path: id,
				base: "",
				module: merged
			};
		},
		loadStylesheet: async (id) => {
			const path = resolve(id);
			const content = stylesheets.get(path);
			if (content === void 0) throw new Error(`Unexpected Tailwind stylesheet: ${id}`);
			return {
				path,
				base: dirname(path),
				content
			};
		}
	});
	if (compiler.sources.length || compiler.root !== null && compiler.root !== "none") throw new Error("Tailwind source(...) directory scanning is not supported; file candidates come from client bundles");
	const css = compiler.build(candidates);
	cached = {
		hash: digest,
		css
	};
	return css;
}
//#endregion
//#region src/constants.ts
const PLUGIN_ID = "dsh-taiwind";
const STYLESHEET_PATH = "plugins/dsh-taiwind.css";
const POLL_INTERVAL_MS = 2e3;
//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
const inject = [
	"clientModules",
	"webServer",
	"connection"
];
async function apply(ctx) {
	let css = "";
	let etag = "";
	let failed = false;
	let disposed = false;
	let generation = 0;
	let pending;
	let lastError = "";
	const refresh = () => {
		if (pending) return pending;
		pending = (async () => {
			while (true) {
				const current = generation;
				const compiled = await compilePlugins(ctx.clientModules.graph().entries.map(({ id }) => {
					const path = ctx.clientModules.clientPath(id);
					if (!path) throw new Error(`Missing client bundle: ${id}`);
					return {
						id,
						path
					};
				}));
				if (disposed) return;
				if (generation !== current) continue;
				css = compiled;
				etag = `"${createHash("sha256").update(css).digest("hex")}"`;
				failed = false;
				lastError = "";
				break;
			}
		})().finally(() => {
			pending = void 0;
		});
		return pending;
	};
	ctx.effect(() => () => {
		disposed = true;
	});
	const update = () => {
		refresh().catch((error) => {
			if (disposed) return;
			failed = true;
			const message = error instanceof Error ? error.message : String(error);
			if (message !== lastError) {
				lastError = message;
				ctx.logger.warn(`${PLUGIN_ID}: ${message}; keeping previous stylesheet`);
			}
		});
	};
	ctx.effect(() => ctx.clientModules.onGraphChanged(() => {
		generation++;
		update();
	}));
	await refresh();
	if (disposed) return;
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `/${STYLESHEET_PATH}`,
		handler: (req, res) => {
			const rejection = ctx.connection.requestRejection(req);
			if (rejection) {
				res.writeHead(rejection);
				res.end();
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { Allow: "GET, HEAD" });
				res.end();
				return;
			}
			res.setHeader("Cache-Control", "private, no-cache");
			res.setHeader("X-Content-Type-Options", "nosniff");
			if (failed) {
				res.writeHead(503, { "Retry-After": "2" });
				res.end();
				return;
			}
			res.setHeader("ETag", etag);
			if (req.headers["if-none-match"] === etag) {
				res.writeHead(304);
				res.end();
				return;
			}
			res.setHeader("Content-Type", "text/css; charset=utf-8");
			res.writeHead(200);
			res.end(req.method === "HEAD" ? void 0 : css);
		}
	}));
	ctx.on("webserver/index-inject", (rows) => {
		rows.push({
			kind: "html",
			placement: "head",
			html: `<style data-plugin="${PLUGIN_ID}" data-plugin-css="utilities">${css.replace(/<\/style/gi, "<\\/style")}</style>`
		});
	});
	ctx.effect(() => {
		const timer = setInterval(update, POLL_INTERVAL_MS);
		timer.unref();
		return () => clearInterval(timer);
	});
}
//#endregion
export { apply, inject, name };
