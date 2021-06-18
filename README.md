# openapi-generator

This CLI is a wrapper for the [OpenAPI Generator CLI](https://github.com/OpenAPITools/openapi-generator-cli).

It will read `services.json` within the provided input directory (default `.scaffoldly`),
and generate client libraries.

## Running

```
npx @scaffoldly/openapi-generator --help
```

### Within a project

```
yarn add --dev @scaffoldly/openapi-generator
```

In `package.json`:

```
  "scripts": {
    "openapi": "yarn openapi-generator -g angular -i .scaffoldly/$NODE_ENV -o src/app/@openapi -r +all"
  },
```

## Usage

```
Usage: openapi-generator [options]

Options:
      --help     Show help                                             [boolean]
      --version  Show version number                                   [boolean]
  -g             Generator, one of: [angular,axios]                   [required]
  -i             Input directory                        [default: ".scaffoldly"]
  -o             Output directory                                     [required]
  -r             Require a response from these services(s), use '+all' to requir
                 e all services                                          [array]

Examples:
  index.js -g angular -o src/app/openapi -  Generate Angular client libraries in
  r +all                                    to src/app/openapi/{service-name}. R
                                            etries until all services are loaded
  index.js -g axios -o src/app/openapi -r   Generate Axios client libraries into
  auth -r foo                                src/app/openapi/{service-name}. Ret
                                            ries until auth and foo are loaded
  index.js -g angular -o src/app/openapi    Generate Angular client libraries in
                                            to src/app/openapi/{service-name}. N
                                            o retries
```

### Usage Tracking Opt-Out

If you want to opt out of usage metrics, set the `DNT` environment variable prior
to running the script, e.g.:

```
DNT=1 npx @scaffoldly/openapi-generator
```
