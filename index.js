const core = require('@actions/core');
const _ = require('lodash');
const Entities = require('html-entities');
const ejs = require('ejs');
const Haikunator = require('haikunator');
const { SourceControl, Jira } = require('jira-changelog');
const RegExpFromString = require('regexp-from-string');
const AWS = require('aws-sdk')
const showdown = require('showdown')

const config = {
  jira: {
    api: {
      host: core.getInput('jira_host'),
      email: core.getInput('jira_email'),
      token: core.getInput('jira_token'),
    },
    baseUrl: core.getInput('jira_base_url'),
    ticketIDPattern: RegExpFromString(core.getInput('jira_ticket_id_pattern')),
    approvalStatus: core.getInput('approval_statuses').split(",").filter(x => x !== ""),
    excludeIssueTypes: core.getInput('exclude_issue_types').split(",").filter(x => x !== ""),
    includeIssueTypes: [],
  },
  sourceControl: {
    defaultRange: {
      from:  core.getInput('source_control_range_from'),
      to: core.getInput('source_control_range_to')
    }
  },
  email: {
    to: core.getInput('email_to'),
    accessKey: core.getInput('aws_access_key'),
    accessSecret: core.getInput('aws_access_secret'),
    appName: core.getInput('app_name')
  }
};



const template = `
<% if (jira.releaseVersions && jira.releaseVersions.length) {  %>
Release version: <%= jira.releaseVersions[0].name -%>
<% jira.releaseVersions.sort((a, b) => a.projectKey.localeCompare(b.projectKey)).forEach((release) => { %>
  * [<%= release.projectKey %>](<%= jira.baseUrl + '/projects/' + release.projectKey + '/versions/' + release.id %>) <% -%>
<% }); -%>
<% } %>

Jira Tickets
---------------------
<% tickets.all.forEach((ticket) => { %>
  * [<%= ticket.fields.issuetype.name %>] - [<%= ticket.key %>](<%= jira.baseUrl + '/browse/' + ticket.key %>) <%= ticket.fields.summary -%>
<% }); -%>
<% if (!tickets.all.length) {%> ~ None ~ <% } %>

<% if (includePendingApprovalSection) { %>
Pending Approval
---------------------
<% tickets.pendingByOwner.forEach((owner) => { %>
<%= (owner.slackUser) ? '@'+owner.slackUser.name : owner.email %>
<% owner.tickets.forEach((ticket) => { -%>
  * <%= jira.baseUrl + '/browse/' + ticket.key %>
<% }); -%>
<% }); -%>
<% if (!tickets.pendingByOwner.length) {%> ~ None. Yay! ~ <% } %>
<% } %>
`;

function generateReleaseVersionName() {
  const hasVersion = process.env.VERSION;
  if (hasVersion) {
    return process.env.VERSION;
  } else {
    const haikunator = new Haikunator();
    return haikunator.haikunate();
  }
}

function transformCommitLogs(config, logs) {
  let approvalStatus = config.jira.approvalStatus;
  if (!Array.isArray(approvalStatus)) {
    approvalStatus = [approvalStatus];
  }

  // Tickets and their commits
  const ticketHash = logs.reduce((all, log) => {
    log.tickets.forEach((ticket) => {
      all[ticket.key] = all[ticket.key] || ticket;
      all[ticket.key].commits = all[ticket.key].commits || [];
      all[ticket.key].commits.push(log);
    });
    return all;
  }, {});
  const ticketList = _.sortBy(Object.values(ticketHash), ticket => ticket.fields.issuetype.name);
  let pendingTickets = ticketList.filter(ticket => !approvalStatus.includes(ticket.fields.status.name));

  // Pending ticket owners and their tickets/commits
  const reporters = {};
  pendingTickets.forEach((ticket) => {
    const email = ticket.fields.reporter.emailAddress;
    if (!reporters[email]) {
      reporters[email] = {
        email,
        name: ticket.fields.reporter.displayName,
        slackUser: ticket.slackUser,
        tickets: [ticket]
      };
    } else {
      reporters[email].tickets.push(ticket);
    }
  });
  const pendingByOwner = _.sortBy(Object.values(reporters), item => item.user);

  // Output filtered data
  return {
    commits: {
      all: logs,
      tickets: logs.filter(commit => commit.tickets.length),
      noTickets: logs.filter(commit => !commit.tickets.length)
    },
    tickets: {
      pendingByOwner,
      all: ticketList,
      approved: ticketList.filter(ticket => approvalStatus.includes(ticket.fields.status.name)),
      pending: pendingTickets
    }
  }
}

async function main() {
  try {
    // Get commits for a range
    const source = new SourceControl(config);
    const jira = new Jira(config);

    const range = config.sourceControl.defaultRange;
    console.log(`Getting range ${range.from}...${range.to} commit logs`);
    const commitLogs = await source.getCommitLogs('./', range);
    console.log('Found following commit logs:');
    console.log(commitLogs);

    console.log('Generating release version');
    const release = generateReleaseVersionName();
    console.log(`Release: ${release}`);

    console.log('Generating Jira changelog from commit logs');
    const changelog = await jira.generate(commitLogs, null);
    console.log('Changelog entry:');
    console.log(changelog);

    console.log('Generating changelog message');
    const data = transformCommitLogs(config, changelog);

    data.jira = {
      baseUrl: config.jira.baseUrl,
      releaseVersions: jira.releaseVersions,
    };
    data.includePendingApprovalSection = core.getInput('include_pending_approval_section') === 'true';

    const entities = new Entities.AllHtmlEntities();
    const changelogMessage = ejs.render(template, data);
    const decodedData = entities.decode(changelogMessage)

    console.log('Changelog message entry:');
    console.log(decodedData);

    core.setOutput('changelog_message', changelogMessage);

    const converter = new showdown.Converter();
    const html = converter.makeHtml(decodedData);


  const params = {
    Destination: { /* required */
      ToAddresses: config.email.to.split(',')
    },
    Message: { /* required */
      Body: { /* required */
        Html: {
          Charset: "UTF-8",
          Data: html
        },
      },
      Subject: {
        Charset: 'UTF-8',
        Data: config.email.appName + ' Release Notes',
      }
    },
    Source: 'info@joulebug.com'
  };

// Create the promise and SES service object
  const sendPromise = new AWS.SES({
    apiVersion: '2010-12-01',
    region: 'us-east-1',
    accessKeyId: config.email.accessKey,
    secretAccessKey: config.email.accessSecret
  }).sendEmail(params).promise();

// Handle promise's fulfilled/rejected states
  sendPromise.then(
      function (data) {
        console.log(data.MessageId);
      }).catch(
      function (err) {
        console.error(err, err.stack);
      });
} catch (e) {
  const message = e && e.message || 'Something went wrong';
  core.setFailed(message);
}
}

main();
