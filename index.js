const request = require("request");
const core = require("@actions/core");
const util = require("util");

// if the API requests fail more than threshold, we will cause exit the script with error code
const FAILURE_THRESHOLD = 10;

// the following variable is added so we can check for intermittent success messages from JenkinsAPI
const SUCCESS_THRESHOLD = 3;
let failureCount = 0;
let successCount = 0;
let jenkinsBuildUrl;

class BadGatewayError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadGatewayError";
  }
}

class JenkinsAPIError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowFailedError";
  }
}

// create auth token for Jenkins API
const API_TOKEN = Buffer.from(
  `${core.getInput("user_name")}:${core.getInput("api_token")}`
).toString("base64");

let timer = setTimeout(() => {
  core.setFailed("Job Timeout");
  core.error("Exception Error: Timed out");
}, Number(core.getInput("timeout")) * 1000);

const sleep = (seconds) => {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, seconds * 1000);
  });
};

// returns the queue item url from the response's location header
async function triggerJenkinsJob(jobName, params) {
  const jenkinsEndpoint = core.getInput("url");
  const req = {
    method: "POST",
    url: `${jenkinsEndpoint}/job/${jobName}/buildWithParameters`,
    form: params,
    headers: {
      Authorization: `Basic ${API_TOKEN}`,
    },
  };
  return new Promise((resolve, reject) =>
    request(req, (err, res) => {
      if (err) {
        core.setFailed(err);
        core.error(JSON.stringify(err));
        clearTimeout(timer);
        reject();
        return;
      }
      const location = res.headers["location"];
      if (!location) {
        const errorMessage = "Failed to find location header in response!";
        core.setFailed(errorMessage);
        core.error(errorMessage);
        clearTimeout(timer);
        reject();
        return;
      }

      resolve(location);
    })
  );
}

async function getJobStatus(jobName, statusUrl) {
  if (!statusUrl.endsWith("/")) statusUrl += "/";

  const req = {
    method: "GET",
    url: `${statusUrl}api/json`,
    headers: {
      Authorization: `Basic ${API_TOKEN}`,
    },
  };
  return new Promise((resolve, reject) =>
    request(req, (err, res, body) => {
      if (err) {
        core.info(`Received an error: ${err.message}`);
        clearTimeout(timer);
        reject(err);
      }
      core.info(`The response code from Jenkins API is: ${res.statusCode}`);
      switch (res.statusCode) {
        case 200:
          resolve(JSON.parse(body));
          break;
        case 502:
          if (failureCount > FAILURE_THRESHOLD) {
            reject(
              new JenkinsAPIError(
                "Failure Threshold reached, exiting script....."
              )
            ); // Reject with JenkinsAPIError if threshold reached
          }
          failureCount += 1;
          reject(
            new BadGatewayError(
              `Wrong http response from host - ${res.statusCode}`
            )
          ); // Reject with BadGatewayError
        default:
          reject(
            new JenkinsAPIError(
              `Unknown API error code received: ${res.statusCode}`
            )
          ); // Reject with JenkinsAPIError on unknown status
      }
    })
  );
}

// see https://issues.jenkins.io/browse/JENKINS-12827
async function waitJenkinsJob(jobName, queueItemUrl, timestamp) {
  const sleepInterval = 10;
  let buildUrl = undefined;
  core.info(`>>> Waiting for '${jobName}' ...`);
  while (true) {
    // check the queue until the job is assigned a build number
    if (!buildUrl) {
      let queueData = await getJobStatus(jobName, queueItemUrl);

      if (queueData.cancelled)
        throw new Error(`Job '${jobName}' was cancelled.`);

      if (queueData.executable && queueData.executable.url) {
        buildUrl = queueData.executable.url;
        core.info(
          `>>> Job '${jobName}' started executing. BuildUrl=${buildUrl}`
        );
        jenkinsBuildUrl =
          typeof jenkinsBuildUrl == "undefined" ? buildUrl : buildUrl;

        if (jenkinsBuildUrl) {
          core.setOutput("jenkinsBuildUrl", jenkinsBuildUrl);
        }
      }

      if (!buildUrl) {
        core.info(
          `>>> Job '${jobName}' is queued (Reason: '${queueData.why}'). Sleeping for ${sleepInterval}s...`
        );
        await sleep(sleepInterval);
        continue;
      }
    }

    try {
      let buildData = await getJobStatus(jobName, buildUrl);

      if (!buildData) {
        core.info("buildData is empty - waiting....");
        await sleep(sleepInterval);
        continue;
      }

      if (buildData.result == "SUCCESS") {
        core.info(
          `Received 'SUCCESS' response from JenkinsAPI, successCount: ${successCount}`
        );
        if (successCount >= SUCCESS_THRESHOLD) {
          core.info(
            `>>> Job '${buildData.fullDisplayName}' - ${jenkinsBuildUrl}, completed successfully!`
          );
          break;
        }
        successCount += 1;
      } else if (
        buildData.result == "FAILURE" ||
        buildData.result == "ABORTED"
      ) {
        throw new Error(
          `Job '${buildData.fullDisplayName}' - ${jenkinsBuildUrl} failed.`
        );
      }

      core.info(
        `>>> Job '${buildData.fullDisplayName}' is executing. Sleeping for ${sleepInterval}s...`
      );
      await sleep(sleepInterval); // API call interval
    } catch (error) {
      if (error instanceof BadGatewayError) {
        core.info(`Received BadGatewayError for Job ${jobName}`);
        await sleep(sleepInterval);
        continue;
      } else {
        core.info(
          `Something went wrong in the Jenkinsjob (prod-to-env sync): ${error.message}`
        );
        throw new Error(`Prod-to-env sync job failed,  ${error.message}`);
      }
    }
  }
}

async function main() {
  try {
    let params = {};
    let startTs = +new Date();
    let jobName = core.getInput("job_name");
    if (core.getInput("parameter")) {
      params = JSON.parse(core.getInput("parameter"));
      core.info(`>>> Parameter ${params.toString()}`);
    }
    // POST API call
    let queueItemUrl = await triggerJenkinsJob(jobName, params);

    core.info(
      `>>> Job '${jobName}' was queued successfully. QueueUrl=${queueItemUrl}`
    );

    // Waiting for job completion
    if (core.getInput("wait") == "true") {
      await waitJenkinsJob(jobName, queueItemUrl, startTs);
    }
  } catch (err) {
    core.setFailed(err.message);
    core.error(err.message);
  } finally {
    clearTimeout(timer);
  }
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
main();
