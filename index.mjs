import SlackClient from '@slack/client';
import firebase from 'firebase-admin';
import micro from 'micro';
import parse from 'urlencoded-body-parser';
import microrouter from 'microrouter';
import crypto from 'crypto';
import schedule from 'node-schedule';

const { router, post, get } = microrouter;
const { send, json, text } = micro;
const { WebClient } = SlackClient;
const slack = new WebClient(process.env.SLACK_TOKEN);

firebase.initializeApp({
  credential: firebase.credential.cert({
    type: `service_account`,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: `https://accounts.google.com/o/oauth2/auth`,
    token_uri: `https://oauth2.googleapis.com/token`,
    auth_provider_x509_cert_url: `https://www.googleapis.com/oauth2/v1/certs`,
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(
      process.env.FIREBASE_CLIENT_EMAIL,
    )}`,
  }),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
});

const store = firebase.firestore();
store.settings({
  timestampsInSnapshots: true,
});

// initUserStore();
distribute();

// https://api.slack.com/docs/verifying-requests-from-slack
function verifyRequest(req, rawBody) {
  const version = 'v0';
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  const sigBaseString = `${version}:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNIN_SECRET);
  hmac.update(sigBaseString);
  const computedSignature = `v0=${hmac.digest('hex')}`;

  return computedSignature === signature;
}

// get slack users and insert them into firestore if they don't already exist
async function initUserStore() {
  console.log('Initiliazing user base...');
  (await slack.users.list()).members
    .filter(user => !user.deleted && !user.is_bot && !user.is_restricted)
    .forEach(async user => {
      const userRef = store.collection('users').doc(user.id);
      if (!(await userRef.get()).exists) {
        console.info(`[USER ADDED] ${user.id} : ${user.name}`);
        userRef.set({ ...user, score: 1, availablePoints: 0 });
      }
    });
  console.log('Done initializing');
}

// adds an amount of points available periodically
function distribute() {
  const count = 6;
  schedule.scheduleJob({ hour: 9, minutes: 30 }, async () => {
    (await slack.users.list()).members.forEach(async slackUser => {
      const userRef = store.collection('users').doc(slackUser.id);
      const user = await userRef.get();
      if (user.exists) {
        console.info(
          `[GAME] ${user.data().id}:${
            user.data().name
          } received ${count} lovebrick`,
        );
        userRef.set({ availablePoints: count }, { merge: true });

        console.log(`[DISTRIBUTE] ${slackUser.name} received ${count}`);

        slack.chat.postMessage({
          channel: slackUser.id,
          text: `You've received ${count} lovebrick. Use them without moderation :heart:`,
        });
      }
    });
  });
}

function getUser(userId) {
  return store
    .collection('users')
    .doc(userId)
    .get();
}

async function updateUserScore(userId, operation) {
  const user = (await getUser(userId)).data();
  store
    .collection('users')
    .doc(userId)
    .set({ score: (user.score || 0) + operation }, { merge: true });
}

async function updateUserAvailablePoints(userId, operation) {
  const user = (await getUser(userId)).data();
  store
    .collection('users')
    .doc(userId)
    .set(
      { availablePoints: (user.availablePoints || 0) + operation },
      { merge: true },
    );
}

const giveRoute = post('/give', async (req, res) => {
  const data = await parse(req);
  let fromName = data.user_name;
  let fromId = data.user_id;

  let reg = data.text.match(/<@([A-Z0-9]*)\|([\S]*)>\s?(-?[0-9]*)?\s?(.*)?/);
  if (!reg) {
    console.warn(`[/give] invalid request: ${data.text}`);
    // same as slack.chat.postEphemeral();
    return send(
      res,
      200,
      `invalid request, have you specified a user to give to ?`,
    );
  }
  let toId = reg[1];
  let toName = reg[2];
  let giveCount;
  if (!reg[3]) {
    giveCount = 1; // default amount sent if none is provided
  } else if (parseInt(reg[3]) < 0) {
    return send(res, 200, `You can't send a negative lovebrick you thief ! ;)`);
  } else {
    giveCount = parseInt(reg[3]);
  }
  let giveMessage = reg[4];

  const [fromUser, toUser] = await Promise.all([
    getUser(fromId),
    getUser(toId),
  ]);
  if (!fromUser.exists) {
    return send(res, 200, `user ${fromName} does not exists`);
  } else if (!toUser.exists) {
    return send(res, 200, `user ${toName} does not exists`);
  }

  if (fromUser.data().availablePoints - giveCount < 0) {
    return send(
      res,
      200,
      `You don't have enough points (${fromUser.data().availablePoints}pts)`,
    );
  }

  slack.chat.postMessage({
    channel: toId,
    text: `@${fromName} gave you ${giveCount} lovebrick${
      giveCount > 1 ? 's' : ''
    }`,
    attachments: [
      {
        text: giveMessage || '',
        callback_id: fromId,
        actions: [
          {
            name: 'reaction',
            text: ':thumbsup:',
            type: 'button',
            value: ':thumbsup:',
          },
          {
            name: 'reaction',
            text: ':joy:',
            type: 'button',
            value: ':joy:',
          },
          {
            name: 'reaction',
            text: ':heart:',
            type: 'button',
            value: ':heart:',
          },
        ],
      },
    ],
  });

  updateUserAvailablePoints(fromId, -giveCount);
  updateUserScore(toId, giveCount);

  console.log(`[/give] ${fromName} => ${toName}`);

  send(res, 200, {
    text: `You gave ${giveCount} lovebrick${
      giveCount > 1 ? 's' : ''
    } to @${toName}`,
    attachments: [
      {
        text: giveMessage,
      },
    ],
  });
});

const countRoute = post('/lovebrick', async (req, res) => {
  const data = await parse(req);
  let fromId = data.user_id;
  let user = await getUser(fromId);
  console.log(`[/count] ${user.name}`);

  send(res, 200, `You have ${user.data().score} lovebricks`);
});

// const eventRoute = post('/event', async (req, res) => {
//   console.log(req);
//   if (req.headers['content-type'] === 'application/json') {
//     const data = await json(req);
//     console.log(data);
//     return send(res, 200, data.challenge);
//   }
//   send(res, 200);
// });

const reactRoute = post('/react', async (req, res) => {
  // TODO: cannot read the reuest body multiple times. How to verify ?
  // const rawBody = await text(req);
  // verify the request comes from slack
  // const verified = await verifyRequest(req, rawBody);
  // // reply nothing if not
  // if (!verified) {
  //   return;
  // }
  const data = await parse(req);
  const body = JSON.parse(data.payload);
  const reaction = body.actions[0].value;

  const originalAuthor = body.original_message.text.match(/@(\S*)/)[1];

  console.log(`[/react] ${body.user.name} => ${originalAuthor}`);

  slack.chat.postMessage({
    channel: body.callback_id,
    text: `@${body.user.name} reacted with ${reaction}`,
    attachments: [
      {
        author_name: `${body.original_message.text}`,
        text: body.original_message.attachments[0].text,
      },
    ],
  });

  send(res, 200, {
    text: `You reacted with ${reaction}`,
    attachments: [
      {
        author_name: `${body.original_message.text}`,
        text: body.original_message.attachments[0].text,
      },
    ],
    replace_original: true,
  });
});

const homeRoute = get('/', async (req, res) => {
  send(res, 200, 'OK');
});

const routes = router(giveRoute, countRoute, reactRoute, homeRoute);
const server = micro(routes);

server.listen(3000);
