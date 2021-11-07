const { parseEther } = require('@ethersproject/units');
const axios = require('axios');
const ethers = require('ethers');


// Configuration globals
var config = {};
var leaders = [];
var active = [];

// Ethers globals (only set after config loading)
var provider = null;
var wallet = null;
var treasury = null;

/**
 * This is the main entry point to your Probot app
 * @param {import('probot').Probot} app
 */
module.exports = async (app, {getRouter}) => {
  app.log.info('Gitvern GitHub App started');

  app.on('issues.opened', async (context) => {
    context.log('Received issues.opened event');
    // const issueComment = context.issue({
    //   body: "Thanks for opening this issue!",
    // });
    // return context.octokit.issues.createComment(issueComment);
  });

  app.on("issues.assigned", async (context) => {
    app.log.info(`Received issues.assigned event`);

    const issue = context.issue();    // { issue_number: 0, owner: '', repo: '' }

    const octokit = await app.auth(config['github-app-installation-id']);
    const project = await loadProject(octokit);
    const item = project.items.find(i => i.number === issue.issue_number && i.repo === issue.repo);

    if (!item) {
      app.log.error(`Couldn't find matching GitHub issue`);
      return;
    }

    if (item.state === 'OPEN' && item.fields.Weight && item.fields.Weight > 0 && item.assignees[0]) {
      app.log.info(`Processing ${item.title} with weight ${item.fields.Weight}...`);

      const payout = findPayout(item.fields.Weight);
      const address = findAddress(item.assignees[0]);

      if (!address) {
        app.log.error(`Couldn't find wallet address for ${item.assignees[0]}`);
        return
      }

      app.log.info(`Assigning reward to ${item.assignees[0]} with payout of ${ethers.utils.formatEther(payout)} ${config['token']['symbol']}`);
      try {
        const tx = await treasury.assign(address, payout);
        app.log.info(`Transaction ${tx.hash}`);

        // Place comment on the issue
        const issueComment = context.issue({
          body: `Reward to @${item.assignees[0]} with conclusion payout of ${ethers.utils.formatEther(payout)} ${config['token']['symbol']} assigned: [${tx.hash}](${config['network']['explorer-url']}/tx/${tx.hash})`,
        });
        context.octokit.issues.createComment(issueComment);
      }
      catch (err) {
        app.log.error(`Error sending transaction: ${err.message}`);
        return
      }
    } else {
      app.log.info(`Issue ${item.title} doesn't qualify for token distribution`);
    }
  });
  
  app.on("issues.unassigned", async (context) => {
    app.log.info(`Received issues.unassigned event`);

    const issue = context.issue();    // { issue_number: 0, owner: '', repo: '' }
    const target = context.payload.assignee.login;

    const octokit = await app.auth(config['github-app-installation-id']);
    const project = await loadProject(octokit);
    const item = project.items.find(i => i.number === issue.issue_number && i.repo === issue.repo);

    if (!item) {
      app.log.error(`Couldn't find matching GitHub issue`);
      return;
    }

    if (item.state === 'OPEN' && item.fields.Weight && item.fields.Weight > 0 && target) {
      app.log.info(`Processing ${item.title} with weight ${item.fields.Weight}...`);

      const payout = findPayout(item.fields.Weight);
      const address = findAddress(target);

      if (!address) {
        app.log.error(`Couldn't find wallet address for ${target}`);
        return
      }

      app.log.info(`Reversing reward to ${target} with payout of ${ethers.utils.formatEther(payout)} ${config['token']['symbol']}`);
      try {
        const tx = await treasury.reverse(address, payout);
        app.log.info(`Transaction ${tx.hash}`);

        // Place comment on the issue
        const issueComment = context.issue({
          body: `Reward to @${target} with conclusion payout of ${ethers.utils.formatEther(payout)} ${config['token']['symbol']} reversed: [${tx.hash}](${config['network']['explorer-url']}/tx/${tx.hash})`,
        });
        context.octokit.issues.createComment(issueComment);
      }
      catch (err) {
        app.log.error(`Error sending transaction: ${err.message}`);
        return
      }
    } else {
      app.log.info(`Issue ${item.title} doesn't qualify for token distribution`);
    }
  });
  
  app.on("issues.closed", async (context) => {
    app.log.info(`Received issues.closed event`);

    const issue = context.issue();    // { issue_number: 0, owner: '', repo: '' }

    const octokit = await app.auth(config['github-app-installation-id']);
    const project = await loadProject(octokit);
    const item = project.items.find(i => i.number === issue.issue_number && i.repo === issue.repo);

    if (!item) {
      app.log.error(`Couldn't find matching GitHub issue`);
      return;
    }

    if (item.state === 'CLOSED' && item.fields.Weight && item.fields.Weight > 0 && item.assignees[0]) {
      app.log.info(`Processing ${item.title} with weight ${item.fields.Weight}...`);

      const payout = findPayout(item.fields.Weight);
      const address = findAddress(item.assignees[0]);

      if (!address) {
        app.log.error(`Couldn't find wallet address for ${item.assignees[0]}`);
        return
      }

      app.log.info(`Releasing reward to ${item.assignees[0]} with payout of ${ethers.utils.formatEther(payout)} ${config['token']['symbol']}`);
      try {
        const tx = await treasury.release(address, payout);
        app.log.info(`Transaction ${tx.hash}`);

        // Place comment on the issue
        const issueComment = context.issue({
          body: `Reward to @${item.assignees[0]} with payout of ${ethers.utils.formatEther(payout)} ${config['token']['symbol']} released: [${tx.hash}](${config['network']['explorer-url']}/tx/${tx.hash})`,
        });
        context.octokit.issues.createComment(issueComment);
      }
      catch (err) {
        app.log.error(`Error sending transaction: ${err.message}`);
        return
      }
    } else {
      app.log.info(`Issue ${item.title} doesn't qualify for token distribution`);
    }
  });

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/

  // Get an express router to expose new HTTP endpoints
  const router = getRouter("/dao");
  router.get("/work", async (req, res) => {
    const octokit = await app.auth(config['github-app-installation-id']);
    const data = await loadProject(octokit);
    res.send(JSON.stringify(data, null, 2));
  });
};

// Get DAO Project data from GitHub GraphQL API
const loadProject = async (octokit) => {
  const data = await octokit.graphql(`
    query {
      organization(login: "${config['github-owner']}") {
        projectNext(number: ${config['github-project-number']}) {
          closed
          description
          number
          title
          items(first: 100) {
            edges {
              node {
                content {
                  ... on Issue {
                    body
                    assignees(last: 3) {
                      edges {
                        node {
                          login
                        }
                      }
                    }
                    labels(last: 20) {
                      edges {
                        node {
                          name
                        }
                      }
                    }
                    number
                    state
                    title
                    repository {
                      name
                    }
                  }
                }
                title
                fieldValues(last: 20) {
                  edges {
                    node {
                      value
                      projectField {
                        name
                      }
                    }
                  }
                }
              }
            }
            totalCount
          }
          fields(last: 20) {
            edges {
              node {
                name
                settings
              }
            }
          }
        }
      }
    }                  
  `);

  var statuses = {};
  try {
    JSON.parse(data.organization.projectNext.fields.edges.map(n => n.node).find(f => f.name === 'Status').settings).options.map(s => {
      statuses[s.id] = s.name;
    });
  }
  catch (err) { }

  const project = {
    number: data.organization.projectNext.number,
    title: data.organization.projectNext.title,
    description: data.organization.projectNext.description,
    closed: data.organization.projectNext.closed
  };

  const items = data.organization.projectNext.items.edges.map(n => ({...n.node.content, fields: n.node.fieldValues.edges.map(n => ({name: n.node.projectField.name, value: n.node.value}))}));
  items.map(i => {
    i.repo = i.repository.name
    delete i.repository;
    const fields = {}
    i.fields.map(f => {
      if (f.name === 'Status') {
        fields[f.name] = statuses[f.value];
      } else {
        fields[f.name] = f.value;
      }
    });
    i.fields = fields;
    i.assignees = i.assignees.edges.map(a => a.node.login);
    i.labels = i.labels.edges.map(l => l.node.name);
  });

  return { ...project, items };
};

// Load DAO Configuration (every 10 minutes)
const loadConfig = async () => {
  var  res;

  try {
    res = await axios('https://raw.githubusercontent.com/gitvern/dao/main/config/config.json');
    config = res.data;
    res = await axios('https://raw.githubusercontent.com/gitvern/dao/main/contributors/leaders.json');
    leaders = res.data;
    res = await axios('https://raw.githubusercontent.com/gitvern/dao/main/contributors/active.json');
    active = res.data;
  }
  catch (err) {
    console.error('Error loading config:', err.message);
  }

  console.log('Config loaded');

  // Setup ethers after config load
  setImmediate(setupEthers);
}
setInterval(loadConfig, 600000);
setImmediate(loadConfig);

// Setup ethers
const setupEthers = () => {
  provider = new ethers.providers.JsonRpcProvider(process.env.RPC_NODE_URL, 'rinkeby');
  wallet = new ethers.Wallet(process.env.MANAGER_ACCOUNT_PRIVATE_KEY, provider);
  console.log('Manager address:', wallet.address);

  const abi = require('./abi/BudgetDAODistributor.json').abi;
  treasury = new ethers.Contract(config['treasury'].contract, abi, wallet);

  console.log('Ethers setup completed');
}

// Find contributor payout
const findPayout = (weight) => { 
  const weights = Object.keys(config['weight-payouts']).map(w => parseInt(w));
  var relw = 0;
  for (let i = 0; weights[i] < parseInt(weight); i++) {
    relw = weights[i];
  }
  return config['weight-payouts'][relw];
}

// Find contributor wallet address
const findAddress = (contrib) => {
  const users = leaders.concat(active);
  const user = users.find(u => u.username === contrib);
  return user ? user['wallet-address'] : null
}
