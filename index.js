const simpleGit = require("simple-git");
const axios = require("axios");

const repoInfo = async () => {
  const log = await simpleGit.default().log({ maxCount: 1 });
  const sha = log.latest.hash;

  const remotes = await simpleGit.default().getRemotes(true);
  const origin = remotes.find((remote) => remote.name === "origin");
  if (!origin) {
    throw new Error("Unable to find remote with name 'origin'");
  }

  const { pathname } = new URL(origin.refs.push);
  if (!pathname) {
    throw new Error(`Unable to extract pathname from ${origin.refs.push}`);
  }

  const organization = pathname.split("/")[1];
  if (!organization) {
    throw new Error(`Unable to extract organization from ${pathname}`);
  }

  const repo = pathname.split("/")[2];
  if (!repo) {
    throw new Error(`Unable to extract repo from ${pathname}`);
  }

  const info = { organization, repo, sha };

  console.log("Repo Info: ", JSON.stringify(info, null, 2));

  return info;
};

const event = (org, repo, action, dnt = false) => {
  if (dnt) {
    return;
  }

  const params = new URLSearchParams();
  params.set("v", "1");
  params.set("t", "event");
  params.set("tid", "UA-196400659-2");
  params.set("ec", "openapi-generator");
  params.set("cid", org);
  params.set("ea", action);
  params.set("el", `${org}/${repo}`);

  axios.default
    .post(`https://www.google-analytics.com/collect?${params.toString()}`)
    .then(() => {})
    .catch((error) => {
      console.error("Event Log Error", error);
    });
};

const run = async () => {
  const { organization, repo } = await repoInfo();

  event(organization, repo, action);
};

(async () => {
  try {
    await run();
  } catch (e) {
    console.error(e);
  }
})();
