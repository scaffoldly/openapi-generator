#!/usr/bin/env node

const simpleGit = require('simple-git');
const axios = require('axios');
const uri = require('uri-js');
const fs = require('fs');
const proc = require('child_process');

const frameworks = {
  angular: {
    generator: 'typescript-angular',
    properties: ['-p apiModulePrefix={serviceNamePascalCase}'],
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
  const log = await simpleGit.default().log({ maxCount: 1 });
  const sha = log.latest.hash;

  const remotes = await simpleGit.default().getRemotes(true);
  const origin = remotes.find((remote) => remote.name === 'origin');
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { path } = uri.parse(origin.refs.push);
  if (!path) {
    throw new Error(`Unable to extract path from ${origin.refs.push}`);
  }

  const organization = path.split('/')[0];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${path}`);
  }

  let repo = path.split('/')[1];
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
    const p = proc.spawn(parts[0], parts.slice(1), {
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
  if (dnt) {
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

  axios.default
    .post(`https://www.google-analytics.com/collect?${params.toString()}`)
    .then(() => {})
    .catch((error) => {
      console.error('Event Log Error', error);
    });
};

const fetchServiceMap = async (inputDirectory, outputDirectory) => {
  if (!fs.existsSync(inputDirectory)) {
    throw new Error(`Missing directory: ${inputDirectory}`);
  }

  if (!fs.existsSync(`${inputDirectory}/services.json`)) {
    throw new Error(`Missing file: ${inputDirectory}/services.json`);
  }

  const services = JSON.parse(fs.readFileSync(fs.openSync(`${inputDirectory}/services.json`)));

  const serviceMap = Object.entries(services).reduce((acc, [key, value]) => {
    const { base_url: baseUrl, service_name: serviceName } = value;
    const openapiUrl = `${baseUrl}/openapi.json`;
    const serviceNamePascalCase = pascalCase(serviceName);
    const outDir = `${outputDirectory}/${serviceName}`;
    console.log(`Discovered ${serviceNamePascalCase} service (${openapiUrl})`);
    acc[key] = {
      openapiUrl,
      serviceName,
      serviceNamePascalCase,
      outputDirectory: outDir,
    };
    return acc;
  }, {});

  return serviceMap;
};

const generateApi = async (
  generatorAlias,
  { openapiUrl, serviceName, serviceNamePascalCase, outputDirectory },
) => {
  const { generator, properties } = frameworks[generatorAlias];

  try {
    await axios.default.get(openapiUrl);
  } catch (e) {
    console.log(`Skipping ${serviceNamePascalCase} using ${openapiUrl}: ${e.message}`);
    return null;
  }

  fs.mkdirSync(outputDirectory, { recursive: true });

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
    console.log(`Generated library for ${serviceNamePascalCase} at ${outputDirectory}`);
  } catch (e) {
    console.log(`Error generating: `, e.message);
  }

  return outputDirectory;
};

const run = async (generator, inputDirectory, outputDirectory) => {
  const { organization, repo } = await repoInfo();
  event(organization, repo, generator);

  if (!Object.keys(frameworks).includes(generator)) {
    throw new Error(`Unknown generator: ${generator}`);
  }

  const serviceMap = await fetchServiceMap(inputDirectory, outputDirectory);

  const promises = Object.values(serviceMap).map(async (properties) => {
    const result = await generateApi(generator, properties);
    return result;
  });

  const results = await Promise.all(promises);
};

(async () => {
  try {
    const argv = require('yargs/yargs')(process.argv.slice(2))
      .usage('Usage: $0 [options]')
      .describe('g', `Generator, one of: [${Object.keys(frameworks)}]`)
      .describe('i', `Input directory`)
      .default('i', '.scaffoldly')
      .describe('o', `Output directory`)
      .example(
        '$0 -g angular -o src/app/@openapi',
        'Generate Angular client libraries into src/app/@openapi/{service-name}',
      )
      .demandOption(['g', 'o']).argv;

    await run(argv.g, argv.i, argv.o);
  } catch (e) {
    console.error(e);
  }
})();
