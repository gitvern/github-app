const { parseEther } = require('@ethersproject/units');
const axios = require('axios');
const ethers = require('ethers');
const Client712 = require('@snapshot-labs/snapshot.js').Client712;


// Configuration globals
var config = {};
var leaders = [];
var active = [];

// Chain globals (only set after config loading)
var provider = null;
var wallet = null;
var treasury = null;

// Snapshot globals (only set after config loading)
var snapshot = null;
var space = null;
var proposals = null;

// Octokit to access github
var octokit = null;

/**
 * This is the main entry point to your Probot app
 * @param {import('probot').Probot} app
 */
module.exports = async (app, {getRouter}) => {
  app.log.info('Gitvern GitHub App started');

  // Save octokit for use in all app features
  octokit = await app.auth(process.env.APP_INSTALLATION_ID);

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

    const project = await loadProject();
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

    const project = await loadProject();
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

  app.on("issues.labeled", async (context) => {
    app.log.info(`Received issues.labeled event`);

    const { issue, label } = context.payload;

    // Check if it's a DAO proposal label and issue is open
    const daoLabels = config['snapshot']['proposals'].map(p => p.label);
    if (!daoLabels.includes(label.name) || issue.state !== 'open') return;

    // Get the voting config
    const voting = config['snapshot']['proposals'].find(p => p.label === label.name).voting;

    // Timestamps
    const now = Math.floor(new Date().valueOf()/1000);
    const start = now + voting['start'];
    const end = start + voting['duration'];

    // Snapshot block
    const block = await provider.getBlockNumber();

    // Proposal body
    const body = `${issue.body}\n\nView on GitHub:\n${issue.html_url}\n\nProposal created by Gitvern.\n`;

    // Metadata
    const metadata = { app: 'gitvern', github: context.issue() };    // { issue_number: 0, owner: '', repo: '' }
    metadata.github.issue_id = issue.id;

    // Create new proposal on Snapshot.org
    try {
      const receipt = await snapshot.proposal(wallet, wallet.address, {
        space: config['snapshot']['space'],
        type: voting['type'],
        title: issue.title,
        body: body,
        choices: voting['choices'],
        start: start,
        end: end,
        snapshot: block + voting['block'], // 13620822,
        network: config['network']['chain-id'],
        strategies: JSON.stringify(space.strategies),
        plugins: JSON.stringify({}),
        metadata: JSON.stringify(metadata)
      });
      console.log(receipt);   // TODO: remove, just for debug
    }
    catch (err) {
      app.log.error(`Error creating proposal in snapshot: ${JSON.stringify(err)}`);
    }
  });

  app.on("issues.unlabeled", async (context) => {
    app.log.info(`Received issues.unlabeled event`);

    const { issue, label } = context.payload;

    // Check if it's the proposal label and issue is open
    const daoLabels = config['snapshot']['proposals'].map(p => p.label);
    if (!daoLabels.includes(label.name) || issue.state !== 'open') return;

    // Check if this type of proposal is cancelable config
    const cancelable = config['snapshot']['proposals'].find(p => p.label === label.name).cancelable;
    if (!cancelable) return;

    // Find the proposal data
    const proposal = findProposal(issue.id);

    // Cancel proposal on Snapshot.org
    try {
      const receipt = await snapshot.cancelProposal(wallet, wallet.address, {
        space: config['snapshot']['space'],
        proposal: proposal.id
      });
    }
    catch (err) {
      app.log.error(`Error canceling proposal in snapshot: ${JSON.stringify(err)}`);
    }
  });
  
  app.on("issues.closed", async (context) => {
    app.log.info(`Received issues.closed event`);

    const issue = context.issue();    // { issue_number: 0, owner: '', repo: '' }

    const project = await loadProject();
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
  // const router = getRouter("/dao");
  // router.get("/work", async (req, res) => {
  //   const data = await loadProject();
  //   res.send(JSON.stringify(data, null, 2));
  // });
};

// Update issues from proposal voting results
const updateIssues = async () => {
  // Check that we have already setup github access
  if (!octokit) return;

  // Load project items from github
  const project = await loadProject();

  // Get closed proposals
  const closed = proposals.filter(p => p.state === 'closed');

  // Go through them and update github if needed
  closed.map(async proposal => {
    // Get the respective issue from project
    const item = project.items.find(i => i.number === proposal.metadata.github.issue_number);

    // Ignore if the field has already value
    if (item.fields[config['github']['field']]) return;

    // Get the github field
    const field = project.fields.find(f => f.name === config['github']['field']);
    if (!field) {
      console.log(`Invalid field ${config['github']['field']} in github configuration`);
      return;
    }

    // Calculate the Approval weight (first choice - all other choices)
    const approval = proposal.scores[0] - (proposal.scores_total - proposal.scores[0]);

    try {
      // Update the field value
      const data = await octokit.graphql(`
        mutation {
          updateProjectNextItemField(input: {
            projectId: "${project.id}", 
            itemId: "${item.id}", 
            fieldId: "${field.id}", 
            value: "${approval}"
          }) {
            clientMutationId
          }
        }
      `);
    }
    catch (err) {
      console.log('Error updating github field. Maybe permissions missing?');
    };
  });

  console.log('GitHub issues updated');
};

// Get DAO Project data from GitHub GraphQL API
const loadProject = async () => {
  const data = await octokit.graphql(`
    query {
      organization(login: "${config['github']['owner']}") {
        projectNext(number: ${config['github']['project-number']}) {
          id
          closed
          description
          number
          title
          items(first: 100) {
            edges {
              node {
                id
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
                id
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
    id: data.organization.projectNext.id,
    number: data.organization.projectNext.number,
    title: data.organization.projectNext.title,
    description: data.organization.projectNext.description,
    closed: data.organization.projectNext.closed
  };

  const items = data.organization.projectNext.items.edges.map(n => ({id: n.node.id,...n.node.content, fields: n.node.fieldValues.edges.map(n => ({name: n.node.projectField.name, value: n.node.value}))}));
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

  const fields = data.organization.projectNext.fields.edges.map(f => ({id: f.node.id, name: f.node.name}));

  return { ...project, items, fields };
};

// Get snapshot proposals and fill in the metadata from IPFS asynchronously
const loadProposals = async () => {
  // Load snapshot proposals data
  const { data } = await snapql(`{
    proposals(
      first: 1000,
      skip: 0,
      where: {
        space_in: ["${config['snapshot']['space']}"],
        author: "${wallet.address}"
      },
      orderBy: "state"
    ) {
      id
      title
      body
      choices
      start
      end
      snapshot
      state
      author
      link
      ipfs
      scores
      scores_state
      scores_total
      scores_updated
      votes
    }
  }`);
  proposals = data.proposals;

  // Fill the metadata from IPFS
  await Promise.all(proposals.map(async p => {
    const data = await ipfs(p.ipfs);
    try {
      p.metadata = JSON.parse(data.data.message.metadata);
    }
    catch(err) {
      console.log('Error parsing metadata from IPFS', err.message);
      p.metadata = {};
    }
  }));

  setImmediate(updateIssues);

  console.log('Snapshot proposals updated');
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

  // Setup chain and snapshot after config load
  setImmediate(setupChain);
  setImmediate(setupSnapshot);
};
setInterval(loadConfig, 600000);
setImmediate(loadConfig);

// Setup Chain
const setupChain = () => {
  provider = new ethers.providers.JsonRpcProvider(process.env.RPC_NODE_URL, 'rinkeby');
  wallet = new ethers.Wallet(process.env.MANAGER_ACCOUNT_PRIVATE_KEY, provider);
  console.log('Manager address:', wallet.address);

  const abi = require('./abi/BudgetDAODistributor.json').abi;
  treasury = new ethers.Contract(config['treasury'].contract, abi, wallet);

  console.log('Blockchain connection completed');
};

// Setup Snapshot
const setupSnapshot = async () => {
  snapshot = new Client712(config['snapshot']['hub']);

  // Load snapshot space data
  const { data } = await snapql(`{
    space(id: "${config['snapshot']['space']}") {
      id
      name
      about
      network
      symbol
      strategies {
        name
        params
      }
      admins
      members
      filters {
        minScore
        onlyMembers
      }
      plugins
    }
  }`);
  space = data.space;

  if (!proposals) {
    setInterval(loadProposals, 300000);
    setImmediate(loadProposals);
  }

  console.log('Snapshot connection completed');
};

// Find contributor payout
const findPayout = (weight) => { 
  const weights = Object.keys(config['weight-payouts']).map(w => parseInt(w));
  var relw = 0;
  for (let i = 0; weights[i] < parseInt(weight); i++) {
    relw = weights[i];
  }
  return config['weight-payouts'][relw];
};

// Find contributor wallet address
const findAddress = (contrib) => {
  const users = leaders.concat(active);
  const user = users.find(u => u.username === contrib);
  return user ? user['wallet-address'] : null
};

// Find a proposal in proposals list with a github issue id
const findProposal = (issue_id) => proposals.find(p => p.metadata.github.issue_id === issue_id);

// Access snapshot graphql
const snapql = async (query) => {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
  
  try {
    const res = await axios.post(config['snapshot']['hub']+'/graphql', { query }, { headers });
    return res.data || null;
  }
  catch(err) {
    console.log('Error from snapshot graphql:', err);
  }
};

// Access ipfs
const ipfs = async (cid) => {
  try {
    const res = await axios.get(config['snapshot']['ipfs']+'/ipfs/'+cid);
    return res.data || null;
  }
  catch(err) {
    console.log('Error getting from IPFS:', err);
  }
};
