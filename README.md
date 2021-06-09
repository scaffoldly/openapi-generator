# openapi-generator

This CLI is a wrapper for the [OpenAPI Generator CLI](https://github.com/OpenAPITools/openapi-generator-cli).

It will read `service.json` within the provided input directory (default `.scaffoldly`),
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
    "openapi": "yarn openapi-generator -g angular -i .scaffoldly/$NODE_ENV -o src/app/@openapi"
  },
```

## Usage

```
Usage: openapi-generator [options]

Options:
      --help     Show help                                             [boolean]
      --version  Show version number                                   [boolean]
  -g             Generator, one of: [angular]                         [required]
  -i             Input directory                        [default: ".scaffoldly"]
  -o             Output directory                                     [required]

Examples:
  openapi-generator -g angular -o           Generate Angular client libraries
  src/app/@openapi                          into src/app/@openapi/{service-name}
```

### Usage Tracking Opt-Out

If you want to opt out of usage metrics, set the `DNT` environment variable prior
to running the script, e.g.:

```
DNT=1 npx @scaffoldly/openapi-generator
```
