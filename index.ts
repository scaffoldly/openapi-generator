#!/usr/bin/env node

import simpleGit from 'simple-git';
import axios, { AxiosError } from 'axios';
import { parse } from 'uri-js';
import { existsSync, realpathSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import yargs from 'yargs';
import { dump } from 'js-yaml';
import PQueue from 'p-queue';
import path from 'path';

const MAX_RETRIES = 120;
const WAIT_FOR = 5000; // milliseconds
const VERSION_FILE = 'version.json';
const VERSIONS_FILE = '.openapis';

const { DNT } = process.env;

type FrameworkAliases = 'angular' | 'axios';
type FrameworkMap = { [key in FrameworkAliases]: { generator: string; properties: string[] } };

const frameworks: FrameworkMap = {
  angular: {
    generator: 'typescript-angular',
    properties: ['-p apiModulePrefix={serviceNamePascalCase}'],
  },
  axios: {
    generator: 'typescript-axios',
    properties: ['-p modelNamePrefix={serviceNamePascalCase}'],
  },
};

const pascalCase = (str: string) => {
  return str
    .replace(/(\w)(\w*)/g, (_g0: string, g1: string, g2: string) => {
      return g1.toUpperCase() + g2.toLowerCase();
    })
    .replace(/[_-]/g, '');
};

const repoInfo = async () => {
  const log = await simpleGit().log({ maxCount: 1 });
  if (!log.latest) {
    throw new Error('Unable to fetch git log');
  }
  const sha = log.latest.hash;

  const remotes = await simpleGit().getRemotes(true);
  const origin = remotes.find((remote) => remote.name === 'origin');
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { path: pushPath } = parse(origin.refs.push);
  if (!pushPath) {
    throw new Error(`Unable to extract path from ${origin.refs.push}`);
  }

  const organization = pushPath.split('/')[pushPath.startsWith('/') ? 1 : 0];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${pushPath}`);
  }

  let repo = pushPath.split('/')[pushPath.startsWith('/') ? 2 : 1];
  if (!repo) {
    throw new Error(`Unable to extract repo from ${pushPath}`);
  }

  if (repo.endsWith('.git')) {
    repo = repo.replace(/(.+)(.git)$/gm, '$1');
  }

  const info = { organization, repo, sha };

  return info;
};

const exec = (command: string) => {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    console.log(`Running Command: ${command}`);

    const parts = command.split(' ');
    const p = spawn(parts[0], parts.slice(1), {
      shell: true,
      env: {
        ...process.env,
      },
    });

    p.on('error', (err) => {
      reject(err);
    });

    p.on('exit', (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });
        return;
      }
      reject(new Error(`Command '${command}' exited with code ${code}`));
    });

    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stdout); // Pipe stderr to stdout too

    p.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`;
    });
    p.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`;
    });
  });
};

const event = (org: string, repo: string, action: string) => {
  if (DNT) {
    return;
  }

  axios
    .post(
      `https://api.segment.io/v1/track`,
      {
        userId: org,
        event: `generate-${action}`,
        properties: { script: 'openapi-generator' },
        context: { repo },
      },
      { auth: { username: 'RvjEAi2NrzWFz3SL0bNwh5yVwrwWr0GA', password: '' } },
    )
    .then(() => {})
    .catch((error: AxiosError) => {
      console.error('Event Log Error', error);
    });
};

type Service = {
  openapiUrl: string;
  serviceName: string;
  serviceNamePascalCase: string;
  outputDirectory: string;
  required: boolean;
};

const fetchServiceMap = async (
  inputDirectory: string,
  outputDirectory: string,
  required: string[] = [],
) => {
  if (!existsSync(inputDirectory)) {
    throw new Error(`Missing directory: ${inputDirectory}`);
  }

  let inDir = realpathSync(inputDirectory);

  if (inDir.indexOf('/$NODE_ENV') !== -1) {
    inDir = inDir.replace('/$NODE_ENV', `${path.sep}${process.env.NODE_ENV} || ''`);
  }

  const servicesFile = path.join(inDir, 'services.json');
  const envVarsFile = path.join(inDir, 'env-vars.json');

  if (!existsSync(servicesFile)) {
    throw new Error(`Missing file: ${servicesFile}`);
  }

  if (!existsSync(envVarsFile)) {
    throw new Error(`Missing file: ${envVarsFile}`);
  }

  console.log(`Using services.json: ${servicesFile}`);
  console.log(`Using env-vars.json: ${envVarsFile}`);

  const services = JSON.parse(readFileSync(servicesFile).toString());
  const envVars = JSON.parse(readFileSync(envVarsFile).toString());

  const serviceMap = Object.entries(services).reduce((acc, [key, value]) => {
    const key$ = key as string;
    const value$ = value as Record<string, string>;
    const baseUrl = value$.base_url || value$['base-url'];
    const serviceName = value$.service_name || value$['service-name'];
    if (envVars.SERVICE_NAME === serviceName || envVars['service-name'] === serviceName) {
      console.log(`Skipping ${serviceName}, that's this project!`);
      return acc;
    }
    const openapiUrl = `${baseUrl}/openapi.json`;
    const serviceNamePascalCase = pascalCase(serviceName);
    const outDir = path.join(outputDirectory, serviceName);
    console.log(`Discovered ${serviceName} service (${openapiUrl})`);
    acc[key$] = {
      openapiUrl,
      serviceName,
      serviceNamePascalCase,
      outputDirectory: outDir,
      required: required.find((r) => r === '+all' || r.toLowerCase() === serviceName)
        ? true
        : false,
    };
    return acc;
  }, {} as { [key: string]: Service });

  return serviceMap;
};

const openUrl = (url: string, required = false, ttl = MAX_RETRIES) => {
  return new Promise((resolve, reject) => {
    ttl = ttl - 1;
    if (ttl <= 0) {
      reject(new Error(`Exceeded maximum retries after ${MAX_RETRIES - ttl} attempts`));
      return;
    }

    axios
      .get(url, {
        validateStatus: (status) => status >= 200 && status < 500,
      })
      .then(({ status, data }) => {
        if (status < 300 && data && data.components) {
          resolve(data);
          return;
        }
        if (!required) {
          reject(new Error(`Not found, status was: ${status}`));
          return;
        }
        console.log(`[Attempt ${MAX_RETRIES - ttl}] Retrying! Status was ${status}: ${url}`);
        setTimeout(() => {
          openUrl(url, required, ttl).then((data2) => {
            resolve(data2);
          });
        }, WAIT_FOR);
        return;
      })
      .catch((e) => {
        reject(e);
        return;
      });
  });
};

type OpenApiDoc = {
  info?: {
    version?: string;
  };
};

type OpenApiVersion = {
  match: boolean;
  old?: string;
  new?: string;
};

const checkVersion = (
  serviceName: string,
  openApi: OpenApiDoc,
  outputDirectory: string,
): OpenApiVersion => {
  const ret: OpenApiVersion = { match: false };
  if (!openApi || !openApi.info || !openApi.info.version) {
    console.log(`Unable to determine version for ${serviceName}: Missing metadata from OpenAPI`);
    return ret;
  }

  const { info } = openApi;
  const { version: openApiVersion } = info;

  if (openApiVersion) {
    ret.new = openApiVersion;
  }

  if (!existsSync(outputDirectory)) {
    console.log(`Unable to determine version for ${serviceName}: Output directory does not exist`);
    return ret;
  }

  try {
    const { version } = JSON.parse(
      readFileSync(path.join(realpathSync(outputDirectory), VERSION_FILE)).toString(),
    );

    if (version) {
      ret.old = version;
    }
  } catch (e) {
    console.log(`Unable to determine version for ${serviceName}: Unable to read version file`);
  }

  if (ret.old && ret.new && ret.old === ret.new) {
    ret.match = true;
    return ret;
  } else {
    console.log(`Updating ${serviceName} from ${ret.old} to ${ret.new}`);
  }

  return ret;
};

const generateApi = async (generatorAlias: FrameworkAliases, service: Service, force = false) => {
  const { generator, properties } = frameworks[generatorAlias];

  let version = null;
  try {
    const openApi = (await openUrl(service.openapiUrl, service.required)) as OpenApiDoc;
    const { match: versionMatch, new: newVersion } = checkVersion(
      service.serviceName,
      openApi,
      service.outputDirectory,
    );
    if (versionMatch && !force) {
      console.log(
        `Skipping ${service.serviceName}: Version (${newVersion}) from OpenAPI and local matches (use -f to force regeneration)`,
      );
      return { serviceName: service.serviceName, version: newVersion };
    } else {
      version = newVersion;
    }
  } catch (e: any) {
    console.log(`Skipping ${service.serviceName} using ${service.openapiUrl}: ${e.message}`, e);
    return { serviceName: service.serviceName, version };
  }

  mkdirSync(service.outputDirectory, { recursive: true });

  const commands = [`npx @openapitools/openapi-generator-cli`];
  commands.push('generate');
  commands.push(`-g ${generator}`);
  commands.push(`-i ${service.openapiUrl}`);
  commands.push(`-o ${service.outputDirectory}`);
  commands.push(
    ...properties.map((p) => {
      return p.replace(`{serviceNamePascalCase}`, service.serviceNamePascalCase);
    }),
  );

  try {
    await exec(commands.join(' '));
    console.log(`Generated library for ${service.serviceName} at ${service.outputDirectory}`);

    if (version) {
      writeFileSync(
        path.join(realpathSync(service.outputDirectory), VERSION_FILE),
        JSON.stringify({ version }),
      );
    }
  } catch (e) {
    console.log(`Error generating: `, e);
  }

  return { serviceName: service.serviceName, version };
};

const run = async (
  generator: FrameworkAliases,
  inputDirectory: string,
  outputDirectory: string,
  required: string[],
  force: boolean,
) => {
  try {
    const { organization, repo } = await repoInfo();
    event(organization, repo, generator);
  } catch (e: any) {
    console.warn('Unable to get repo info', e.message);
  }

  if (!Object.keys(frameworks).includes(generator)) {
    throw new Error(`Unknown generator: ${generator}`);
  }

  const serviceMap = await fetchServiceMap(inputDirectory, outputDirectory, required);

  const promises = Object.values(serviceMap).map((properties) => {
    return async () => generateApi(generator, properties, force);
  });

  const queue = new PQueue({ concurrency: 1 });
  const versions = await queue.addAll(promises);

  mkdirSync(outputDirectory, { recursive: true });
  const yamlStr = dump(versions);
  writeFileSync(
    realpathSync(VERSIONS_FILE),
    `
# Do not edit this file, it is managed by @scaffoldly/openapi-generator
#
# This file assists caching of auto-generated APIs in \`${outputDirectory}\` during builds
#
# This file is *safe* to add to source control and will increase the speed of builds
---
${yamlStr}
`,
  );
};

(async () => {
  try {
    const argv = await yargs(process.argv.slice(2))
      .usage('Usage: $0 [options]')
      .describe('g', `Generator, one of: [${Object.keys(frameworks)}]`)
      .default('g', 'axios')
      .describe('i', `Input directory`)
      .default('i', '.scaffoldly')
      .describe('o', `Output directory`)
      .describe('f', 'Force generation (exclude version checks)')
      .boolean('f')
      .default('f', false)
      .describe(
        'r',
        "Require a response from these services(s), use '+all' to require all services",
      )
      .array('r')
      .example(
        '$0 -g angular -o src/app/openapi -r +all',
        'Generate Angular client libraries into src/app/openapi/{service-name}. Retries until all services are loaded',
      )
      .example(
        '$0 -g axios -o src/app/openapi -r auth -r foo',
        'Generate Axios client libraries into src/app/openapi/{service-name}. Retries until auth and foo are loaded',
      )
      .example(
        '$0 -g angular -o src/app/openapi',
        'Generate Angular client libraries into src/app/openapi/{service-name}. No retries',
      )
      .demandOption(['g', 'o']).argv;

    await run(argv.g as FrameworkAliases, argv.i, argv.o as string, argv.r as string[], argv.f);
  } catch (e) {
    console.error(e);
  }
})();
