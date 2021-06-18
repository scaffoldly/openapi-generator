#!/usr/bin/env node

import simpleGit from 'simple-git';
import axios from 'axios';
import { parse } from 'uri-js';
import { existsSync, realpathSync, readFileSync, openSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import PQueue from 'p-queue';
import yargs from 'yargs';

const MAX_RETRIES = 120;
const WAIT_FOR = 5000; // milliseconds

const { DNT } = process.env;

const frameworks = {
  angular: {
    generator: 'typescript-angular',
    properties: ['-p apiModulePrefix={serviceNamePascalCase}'],
  },
  axios: {
    generator: 'typescript-axios',
    properties: ['-p modelNamePrefix={serviceNamePascalCase}'],
  },
};

const pascalCase = (str) => {
  return str
    .replace(/(\w)(\w*)/g, (g0, g1, g2) => {
      return g1.toUpperCase() + g2.toLowerCase();
    })
    .replace(/[_-]/g, '');
};

const repoInfo = async () => {
  const log = await simpleGit().log({ maxCount: 1 });
  const sha = log.latest.hash;

  const remotes = await simpleGit().getRemotes(true);
  const origin = remotes.find((remote) => remote.name === 'origin');
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { path } = parse(origin.refs.push);
  if (!path) {
    throw new Error(`Unable to extract path from ${origin.refs.push}`);
  }

  const organization = path.split('/')[path.startsWith('/') ? 1 : 0];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${path}`);
  }

  let repo = path.split('/')[path.startsWith('/') ? 2 : 1];
  if (!repo) {
    throw new Error(`Unable to extract repo from ${path}`);
  }

  if (repo.endsWith('.git')) {
    repo = repo.replace(/(.+)(.git)$/gm, '$1');
  }

  const info = { organization, repo, sha };

  return info;
};

const exec = (command) => {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const env = {
      ...process.env,
    };

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

    p.on('exit', (code, signal) => {
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

const event = (org, repo, action, dnt = false) => {
  if (DNT) {
    return;
  }

  const params = new URLSearchParams();
  params.set('v', '1');
  params.set('t', 'event');
  params.set('tid', 'UA-196400659-2');
  params.set('ec', 'openapi-generator');
  params.set('cid', org);
  params.set('ea', `generate-${action}`);
  params.set('el', `${org}/${repo}`);

  axios
    .post(`https://www.google-analytics.com/collect?${params.toString()}`)
    .then(() => {})
    .catch((error) => {
      console.error('Event Log Error', error);
    });
};

const fetchServiceMap = async (inputDirectory, outputDirectory, required = []) => {
  if (!existsSync(inputDirectory)) {
    throw new Error(`Missing directory: ${inputDirectory}`);
  }

  const inDir = realpathSync(inputDirectory);

  const servicesFile = `${inDir}/services.json`;
  const envVarsFile = `${inDir}/env-vars.json`;

  if (!existsSync(servicesFile)) {
    throw new Error(`Missing file: ${servicesFile}`);
  }

  if (!existsSync(envVarsFile)) {
    throw new Error(`Missing file: ${envVarsFile}`);
  }

  console.log(`Using services.json: ${servicesFile}`);
  console.log(`Using env-vars.json: ${envVarsFile}`);

  const services = JSON.parse(readFileSync(openSync(servicesFile)));
  const envVars = JSON.parse(readFileSync(openSync(envVarsFile)));

  const serviceMap = Object.entries(services).reduce((acc, [key, value]) => {
    const { base_url: baseUrl, service_name: serviceName } = value;
    if (envVars.SERVICE_NAME === serviceName) {
      console.log(`Skipping ${serviceName}, that's this project!`);
      return acc;
    }
    const openapiUrl = `${baseUrl}/openapi.json`;
    const serviceNamePascalCase = pascalCase(serviceName);
    const outDir = `${outputDirectory}/${serviceName}`;
    console.log(`Discovered ${serviceName} service (${openapiUrl})`);
    acc[key] = {
      openapiUrl,
      serviceName,
      serviceNamePascalCase,
      outputDirectory: outDir,
      required: required.find((r) => r === '+all' || r.toLowerCase() === serviceName)
        ? true
        : false,
    };
    return acc;
  }, {});

  return serviceMap;
};

const openUrl = (url, required = false, ttl = MAX_RETRIES) => {
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
          openUrl(url, required, ttl).then((data) => {
            resolve(data);
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

const generateApi = async (
  generatorAlias,
  { openapiUrl, serviceName, serviceNamePascalCase, outputDirectory, required },
) => {
  const { generator, properties } = frameworks[generatorAlias];

  try {
    await openUrl(openapiUrl, required);
  } catch (e) {
    console.log(`Skipping ${serviceName} using ${openapiUrl}: ${e.message}`);
    return null;
  }

  mkdirSync(outputDirectory, { recursive: true });

  let commands = [`npx @openapitools/openapi-generator-cli`];
  commands.push('generate');
  commands.push(`-g ${generator}`);
  commands.push(`-i ${openapiUrl}`);
  commands.push(`-o ${outputDirectory}`);
  commands.push(
    properties.map((p) => {
      return p.replace(`{serviceNamePascalCase}`, serviceNamePascalCase);
    }),
  );

  try {
    await exec(commands.join(' '));
    console.log(`Generated library for ${serviceName} at ${outputDirectory}`);
  } catch (e) {
    console.log(`Error generating: `, e.message);
  }

  return outputDirectory;
};

const run = async (generator, inputDirectory, outputDirectory, required) => {
  const { organization, repo } = await repoInfo();
  event(organization, repo, generator);

  if (!Object.keys(frameworks).includes(generator)) {
    throw new Error(`Unknown generator: ${generator}`);
  }

  const serviceMap = await fetchServiceMap(inputDirectory, outputDirectory, required);

  const promises = Object.values(serviceMap).map((properties) => {
    return async () => await generateApi(generator, properties);
  });

  const queue = new PQueue({ concurrency: 1 });
  await queue.addAll(promises);
};

(async () => {
  try {
    const argv = yargs(process.argv.slice(2))
      .usage('Usage: $0 [options]')
      .describe('g', `Generator, one of: [${Object.keys(frameworks)}]`)
      .describe('i', `Input directory`)
      .default('i', '.scaffoldly')
      .describe('o', `Output directory`)
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

    await run(argv.g, argv.i, argv.o, argv.r);
  } catch (e) {
    console.error(e);
  }
})();
