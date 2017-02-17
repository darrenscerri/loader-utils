"use strict";

const JSON5 = require("json5");
const path = require("path");
const util = require("util");
const os = require("os");
const emojiRegex = /[\uD800-\uDFFF]./;
const emojiList = require("emojis-list").filter(emoji => emojiRegex.test(emoji));
const matchNativeWin32Path = /^[A-Z]:[/\\]|^\\\\/i;
const matchRelativePath = /^\.\.?[/\\]/;

const baseEncodeTables = {
	26: "abcdefghijklmnopqrstuvwxyz",
	32: "123456789abcdefghjkmnpqrstuvwxyz", // no 0lio
	36: "0123456789abcdefghijklmnopqrstuvwxyz",
	49: "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ", // no lIO
	52: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
	58: "123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ", // no 0lIO
	62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
	64: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"
};
const emojiCache = {};
const parseQueryDeprecationWarning = util.deprecate(() => {},
	"loaderUtils.parseQuery() received a non-string value which can be problematic, " +
	"see https://github.com/webpack/loader-utils/issues/56" + os.EOL +
	"parseQuery() will be replaced with getOptions() in the next major version of loader-utils."
);

function isAbsolutePath(str) {
	return path.posix.isAbsolute(str) || path.win32.isAbsolute(str);
}

function isRelativePath(str) {
	return matchRelativePath.test(str);
}

function encodeStringToEmoji(content, length) {
	if(emojiCache[content]) return emojiCache[content];
	length = length || 1;
	const emojis = [];
	do {
		const index = Math.floor(Math.random() * emojiList.length);
		emojis.push(emojiList[index]);
		emojiList.splice(index, 1);
	} while(--length > 0);
	const emojiEncoding = emojis.join("");
	emojiCache[content] = emojiEncoding;
	return emojiEncoding;
}

function encodeBufferToBase(buffer, base) {
	const encodeTable = baseEncodeTables[base];
	if(!encodeTable) throw new Error("Unknown encoding base" + base);

	const readLength = buffer.length;

	const Big = require("big.js");
	Big.RM = Big.DP = 0;
	let b = new Big(0);
	for(let i = readLength - 1; i >= 0; i--) {
		b = b.times(256).plus(buffer[i]);
	}

	let output = "";
	while(b.gt(0)) {
		output = encodeTable[b.mod(base)] + output;
		b = b.div(base);
	}

	Big.DP = 20;
	Big.RM = 1;

	return output;
}

function parseQuery(query) {
	const specialValues = {
		"null": null,
		"true": true,
		"false": false
	};
	if(!query) return {};
	if(typeof query !== "string") {
		parseQueryDeprecationWarning();
		return query;
	}
	if(query.substr(0, 1) !== "?")
		throw new Error("a valid query string passed to parseQuery should begin with '?'");
	query = query.substr(1);
	if(query.substr(0, 1) === "{" && query.substr(-1) === "}") {
		return JSON5.parse(query);
	}
	const queryArgs = query.split(/[,\&]/g);
	const result = {};
	queryArgs.forEach(arg => {
		const idx = arg.indexOf("=");
		if(idx >= 0) {
			let name = arg.substr(0, idx);
			let value = decodeURIComponent(arg.substr(idx + 1));
			if(specialValues.hasOwnProperty(value)) {
				value = specialValues[value];
			}
			if(name.substr(-2) === "[]") {
				name = decodeURIComponent(name.substr(0, name.length - 2));
				if(!Array.isArray(result[name]))
					result[name] = [];
				result[name].push(value);
			} else {
				name = decodeURIComponent(name);
				result[name] = value;
			}
		} else {
			if(arg.substr(0, 1) === "-") {
				result[decodeURIComponent(arg.substr(1))] = false;
			} else if(arg.substr(0, 1) === "+") {
				result[decodeURIComponent(arg.substr(1))] = true;
			} else {
				result[decodeURIComponent(arg)] = true;
			}
		}
	});
	return result;
}

function getLoaderConfig(loaderContext, defaultConfigKey) {
	const query = parseQuery(loaderContext.query);
	const configKey = query.config || defaultConfigKey;
	if(configKey) {
		const config = loaderContext.options[configKey] || {};
		delete query.config;
		return Object.assign({}, config, query);
	}

	return query;
}

function stringifyRequest(loaderContext, request) {
	const splitted = request.split("!");
	const context = loaderContext.context || (loaderContext.options && loaderContext.options.context);
	return JSON.stringify(splitted.map(part => {
		// First, separate singlePath from query, because the query might contain paths again
		const splittedPart = part.match(/^(.*?)(\?.*)/);
		let singlePath = splittedPart ? splittedPart[1] : part;
		const query = splittedPart ? splittedPart[2] : "";
		if(isAbsolutePath(singlePath) && context) {
			singlePath = path.relative(context, singlePath);
			if(isAbsolutePath(singlePath)) {
				// If singlePath still matches an absolute path, singlePath was on a different drive than context.
				// In this case, we leave the path platform-specific without replacing any separators.
				// @see https://github.com/webpack/loader-utils/pull/14
				return singlePath + query;
			}
			if(isRelativePath(singlePath) === false) {
				// Ensure that the relative path starts at least with ./ otherwise it would be a request into the modules directory (like node_modules).
				singlePath = "./" + singlePath;
			}
		}
		return singlePath.replace(/\\/g, "/") + query;
	}).join("!"));
}

function dotRequest(obj) {
	return obj.request;
}

function getRemainingRequest(loaderContext) {
	if(loaderContext.remainingRequest)
		return loaderContext.remainingRequest;
	const request = loaderContext.loaders.slice(loaderContext.loaderIndex + 1).map(dotRequest).concat([loaderContext.resource]);
	return request.join("!");
}

function getCurrentRequest(loaderContext) {
	if(loaderContext.currentRequest)
		return loaderContext.currentRequest;
	const request = loaderContext.loaders.slice(loaderContext.loaderIndex).map(dotRequest).concat([loaderContext.resource]);
	return request.join("!");
}

function isUrlRequest(url, root) {
	// An URL is not an request if
	// 1. it's a Data Url
	// 2. it's an absolute url or and protocol-relative
	// 3. it's some kind of url for a template
	if(/^data:|^chrome-extension:|^(https?:)?\/\/|^[\{\}\[\]#*;,'§\$%&\(=?`´\^°<>]/.test(url)) return false;
	// 4. It's also not an request if root isn't set and it's a root-relative url
	if((root === undefined || root === false) && /^\//.test(url)) return false;
	return true;
}

function urlToRequest(url, root) {
	const moduleRequestRegex = /^[^?]*~/;
	let request;

	// we can't use path.win32.isAbsolute because it also matches paths starting with a forward slash
	if(matchNativeWin32Path.test(url)) {
		// absolute windows path, keep it
		request = url;
	} else if(root !== undefined && root !== false && /^\//.test(url)) {
		// if root is set and the url is root-relative
		switch(typeof root) {
			// 1. root is a string: root is prefixed to the url
			case "string":
				// special case: `~` roots convert to module request
				if(moduleRequestRegex.test(root)) {
					request = root.replace(/([^~\/])$/, "$1/") + url.slice(1);
				} else {
					request = root + url;
				}
				break;
			// 2. root is `true`: absolute paths are allowed
			//    *nix only, windows-style absolute paths are always allowed as they doesn't start with a `/`
			case "boolean":
				request = url;
				break;
			default:
				throw new Error("Unexpected parameters to loader-utils 'urlToRequest': url = " + url + ", root = " + root + ".");
		}
	} else if(/^\.\.?\//.test(url)) {
		// A relative url stays
		request = url;
	} else {
		// every other url is threaded like a relative url
		request = "./" + url;
	}

	// A `~` makes the url an module
	if(moduleRequestRegex.test(request)) {
		request = request.replace(moduleRequestRegex, "");
	}

	return request;
}

function parseString(str) {
	try {
		if(str[0] === "\"") return JSON.parse(str);
		if(str[0] === "'" && str.substr(str.length - 1) === "'") {
			return parseString(
				str
					.replace(/\\.|"/g, x => x === "\"" ? "\\\"" : x)
					.replace(/^'|'$/g, "\"")
			);
		}
		return JSON.parse("\"" + str + "\"");
	} catch(e) {
		return str;
	}
}

function getHashDigest(buffer, hashType, digestType, maxLength) {
	hashType = hashType || "md5";
	maxLength = maxLength || 9999;
	const hash = require("crypto").createHash(hashType);
	hash.update(buffer);
	if(digestType === "base26" || digestType === "base32" || digestType === "base36" ||
		digestType === "base49" || digestType === "base52" || digestType === "base58" ||
		digestType === "base62" || digestType === "base64") {
		return encodeBufferToBase(hash.digest(), digestType.substr(4)).substr(0, maxLength);
	} else {
		return hash.digest(digestType || "hex").substr(0, maxLength);
	}
}

function interpolateName(loaderContext, name, options) {
	let filename;
	if(typeof name === "function") {
		filename = name(loaderContext.resourcePath);
	} else {
		filename = name || "[hash].[ext]";
	}
	const context = options.context;
	const content = options.content;
	const regExp = options.regExp;
	let ext = "bin";
	let basename = "file";
	let directory = "";
	let folder = "";
	if(loaderContext.resourcePath) {
		let resourcePath = loaderContext.resourcePath;
		const idx = resourcePath.lastIndexOf(".");
		const i = resourcePath.lastIndexOf("\\");
		const j = resourcePath.lastIndexOf("/");
		const p = i < 0 ? j : j < 0 ? i : i < j ? i : j;
		if(idx >= 0) {
			ext = resourcePath.substr(idx + 1);
			resourcePath = resourcePath.substr(0, idx);
		}
		if(p >= 0) {
			basename = resourcePath.substr(p + 1);
			resourcePath = resourcePath.substr(0, p + 1);
		}
		if(typeof context !== "undefined") {
			directory = path.relative(context, resourcePath + "_").replace(/\\/g, "/").replace(/\.\.(\/)?/g, "_$1");
			directory = directory.substr(0, directory.length - 1);
		} else {
			directory = resourcePath.replace(/\\/g, "/").replace(/\.\.(\/)?/g, "_$1");
		}
		if(directory.length === 1) {
			directory = "";
		} else if(directory.length > 1) {
			folder = path.basename(directory);
		}
	}
	let url = filename;
	if(content) {
		// Match hash template
		url = url
			.replace(
				/\[(?:(\w+):)?hash(?::([a-z]+\d*))?(?::(\d+))?\]/ig,
				(all, hashType, digestType, maxLength) => getHashDigest(content, hashType, digestType, parseInt(maxLength, 10))
			)
			.replace(
				/\[emoji(?::(\d+))?\]/ig,
				(all, length) => encodeStringToEmoji(content, length)
			);
	}
	url = url
		.replace(/\[ext\]/ig, () => ext)
		.replace(/\[name\]/ig, () => basename)
		.replace(/\[path\]/ig, () => directory)
		.replace(/\[folder\]/ig, () => folder);
	if(regExp && loaderContext.resourcePath) {
		const match = loaderContext.resourcePath.match(new RegExp(regExp));
		match && match.forEach((matched, i) => {
			url = url.replace(
				new RegExp("\\[" + i + "\\]", "ig"),
				matched
			);
		});
	}
	if(typeof loaderContext.options === "object" && typeof loaderContext.options.customInterpolateName === "function") {
		url = loaderContext.options.customInterpolateName.call(loaderContext, url, name, options);
	}
	return url;
}

exports.parseQuery = parseQuery;
exports.getLoaderConfig = getLoaderConfig;
exports.stringifyRequest = stringifyRequest;
exports.getRemainingRequest = getRemainingRequest;
exports.getCurrentRequest = getCurrentRequest;
exports.isUrlRequest = isUrlRequest;
exports.urlToRequest = urlToRequest;
exports.parseString = parseString;
exports.getHashDigest = getHashDigest;
exports.interpolateName = interpolateName;
