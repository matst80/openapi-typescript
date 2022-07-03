import fetch from "node-fetch";
import { readFile } from 'fs/promises';

const baseUrl = "https://events.tornberg.me"

const urls = [
	"/product/v1/swagger.json",
	"/order/v1/swagger.json",
	"/inventory/v1/swagger.json",
	"/price/v1/swagger.json",
];

const handleNumber = (type) => {
	if (type === "integer" || type === "float" || type === "double") {
		return "number";
	}
	return type;
};

const getRef = (ref) => {
	const parts = ref.split('/');
	return parts[parts.length - 1];
}

const getType = (data) => {
	if (!data)
		return 'any';
	let { type, $ref, format, items } = data;
	let add = "";

	if (type === "array") {
		//console.log(data);
		add = "[]";
		type = items.type;
		$ref = items.$ref;
	}
	if (type) {
		if (format === "date-time") {
			return "Date" + add;
		}
		return handleNumber(type) + add;
	}
	if ($ref) {
		return safeName(getRef($ref)) + add;
	}
	return "any";
};

const isRequiredFactory = (required = []) => (v) => {
	// if (required.length == 0)
	// 	return true;
	return required.includes(v);
}


const convertProperties = (properties, required = []) => {
	const isReq = isRequiredFactory(required);
	return Object.entries(properties).map(([key, value]) => {
		if (value.type === "object") {
			// if (value.properties !== undefined) {
			// 	return `{
			// 		${convertProperties(value.properties).map(({ name, type }) => `${name}${req.includes(name) ? '' : '?'}:${type}`).join("\n")}
			// 	}`;
			// }
			return {
				name: key,
				type: `{[key:string]:${getType(value.additionalProperties)}}`,
			};
		}
		// if (value.type === "array") {
		//   //console.log(key,value);

		//   return {
		//     name: key,
		//     type: getType(value.items) + "[]",
		//   };
		// }

		return {
			name: key + (value.nullable || !isReq(key) ? "?" : ""),
			type: getType(value),
		};
	});
};

const convertSchemas = (schemas) => {
	return Object.entries(schemas).map(([key, value]) => {
		const { enum: enumValues, items, type, properties, required = [] } = value;

		if (enumValues) {
			return `export type ${key} = ${enumValues
				.map(JSON.stringify)
				.join("|")};`;
		}
		if (type === "array") {
			if (items.$ref) {
				console.log("convert to array of ref", key, items.$ref);
			}
			console.log("array", key, value.items);
		}
		if (type === "object") {
			return `export interface ${safeName(key)} {\n${convertProperties(properties, required)
				.map(({ name, type }) => {
					return `${name}: ${type};`;
				})
				.join("\n")}\n}`;
		} else {
			console.log("fail", value);
			return value;
		}
	});
};

function capitalizeFirstLetter(string) {
	return string.charAt(0).toUpperCase() + string.slice(1);
}

const methodToName = (method) => {
	if (method === "put") {
		return "update";
	}
	if (method === "post") {
		return "add";
	}
	if (method === "delete") {
		return "delete";
	}
	return method;
};

const getEndpointName = (key, method, { parameters, operationId }) => {
	if (operationId !== undefined) {
		return operationId;
	}
	const toExclude = (parameters || []).map((d) => d.name);
	const keys = key.split("/").map(d => d.split('-')).flat();
	const parts = keys.filter((n) => !toExclude.some((q) => n.includes(q)));
	const by = keys
		.filter((n) => toExclude.some((q) => n.includes(q)))
		.map((n) => n.substring(1, n.length - 1));

	return (
		methodToName(method) +
		parts.map(capitalizeFirstLetter).join("") +
		by.map((e) => "By" + capitalizeFirstLetter(e)).join("")
	);
};

const safeName = (name) => {
	return name.replace(/[^a-zA-Z0-9_]/g, "");
}

const getParameters = (parameters, body) => {
	const result = (parameters || []).sort((a, b) => b.required - a.required).map(
		({ name, schema }) => safeName(name) + ": " + getType(schema)
	);
	if (body) {

		result.push("body: " + getType(body.content["application/json"].schema));
	}
	return result;
};

const getBestContentType = (content) => {
	const keys = Object.keys(content || {});
	if (keys.includes("application/json")) {
		return content["application/json"];
	}
	if (keys.includes("text/json")) {
		return content["text/json"];
	}
	return content[keys[0]];
};

const getResponseTypes = (responses) => {
	return Object.entries(responses).filter(([status]) => isOk(status)).map(([status, { content, schema }]) => {
		//console.log(status, content);
		if (schema) {
			return getType(schema)
		}
		if (!content) {
			//console.log("no content", status);
			return "unknown";
		} else {
			const bestContent = getBestContentType(content);
			const type = getType(bestContent.schema);
			//console.log(type);
			return type;
		}
	});
};

const isOk = (status) => {
	const statusNr = Number(status)
	return (statusNr >= 200 && statusNr < 300);
}

const getResponseHandlers = (responses) => {
	return Object.entries(responses).map(([status, { content, schema }]) => {
		//console.log(status, content);
		let type = "unknown";
		if (schema) {
			type = getType(schema)
		}
		else {
			if (!!content) {
				const bestContent = getBestContentType(content);
				type = getType(bestContent.schema);
			}
		}
		if (isOk(status)) {
			return `if (res.status === ${status}) {
				return ${type === 'unknown' ? 'res' : `res.json() as Promise<${type}>`};
			}`;
		}
		return '';
	}).join("\n") + "\nthrow new Error(res.statusText);\n";
};

function onlyUnique(value, index, self) {
	return self.indexOf(value) === index;
}

const nameFactory = (replace) => (name) => {
	let result = name;
	replace.forEach(({ from, to }) => {
		result = result.replace(from, to);
	});
	return result;
}

const parameterIn = (value) => ({ in: w }) => w === value;

const convertEndpoints = (paths, nameReplace = []) => {
	const fixName = nameFactory(nameReplace);
	return Object.entries(paths)
		.map(([key, value]) => {
			return Object.entries(value).map(([method, data]) => {
				const { parameters: allHeaders, requestBody, responses } = data;
				const isHeadParam = parameterIn('header')
				const parameters = (allHeaders || []).filter(d => d.required || !isHeadParam(d));
				const types = getResponseTypes(responses).filter(onlyUnique).join("|");
				const name = getEndpointName(key, method, data);
				const headerParams = (parameters || []).filter(isHeadParam).map(({ name }) => {
					return `["${name}"]: \`\${JSON.stringify(${safeName(name)})}\``;
				});
				const options = `, {
					method: "${method}",
					headers:{
						"content-type": "application/json",
						${headerParams.join(',')}
					},
					${(requestBody || (parameters || []).some(parameterIn('body'))) ? `body: JSON.stringify(body||{}),` : ""}
				}`;
				const queryParams = (parameters || []).filter(parameterIn('query'));

				const queryString = queryParams.length ? '?' + queryParams.map(({ name }) => `${name}=\${encodeURIComponent(${safeName(name)})}`).join("&") : '';
				const jsonOptions = method !== "get" ? options : "";
				const responseTypes = `<${types}>`;
				return `export const ${fixName(name)} = (${getParameters(
					parameters,
					requestBody
				).join(", ")}):Promise${responseTypes} => fetch(\`\${baseUrl}${key.replace(
					/\{/gi,
					"${"
				)}${queryString}\`${jsonOptions}).then(res => {
					if (!res.ok) {
						throw new Error(res.statusText);
					}
					${getResponseHandlers(responses)}
				});`;
			});
		})
		.flat();
};

const convert = ({ partsToRemove = [] } = {}) => (data) => {
	const typeText = convertSchemas(
		data
			.map((d) => d.definitions || d.components.schemas)
			.reduce((a, s) => ({ ...a, ...s }), {})
	).join("\n\n");
	const apiText = convertEndpoints(
		data.map((d) => d.paths).reduce((a, s) => ({ ...a, ...s }), {})
		, partsToRemove).join("\n\n");
	console.log(`const baseUrl="${baseUrl}"`);
	console.log(apiText);
	console.log(typeText);
};

Promise.all(urls.map((d) => fetch(baseUrl + d).then((res) => res.json()))).then(
	convert()
);

const files = [
	'./klarna/ordermanagement.json',
	'./klarna/checkout.json',
]

// Promise.all(files.map((d) => readFile(d).then((res) => JSON.parse(res)))).then(
// 	convert({ partsToRemove: [{ from: 'OrdermanagementV1', to: '' }, { from: 'V3Orders', to: '' }, { from: 'ByOrder_id', to: 'ById' }] })
// );