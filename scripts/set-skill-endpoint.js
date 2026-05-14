"use strict";

const fs = require("fs");
const path = require("path");

const lambdaArn = process.env.LAMBDA_ARN;
if (!lambdaArn) {
  throw new Error("LAMBDA_ARN is required");
}

const skillPath = path.join(__dirname, "..", "skill-package", "skill.json");
const skill = JSON.parse(fs.readFileSync(skillPath, "utf8"));

skill.manifest.apis.custom.endpoint = {
  uri: lambdaArn
};

fs.writeFileSync(skillPath, `${JSON.stringify(skill, null, 2)}\n`);
