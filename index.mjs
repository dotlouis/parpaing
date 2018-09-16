import SlackClient from '@slack/client';
import firebase from 'firebase-admin';
import micro from 'micro';
import parse from 'urlencoded-body-parser';
import serviceAccount from './parpaing-e3e5c-firebase-adminsdk-sxqzn-23c4cf2924.json';
import microrouter from 'microrouter';

const { router, post, get } = microrouter;
const { send } = micro;
const { WebClient } = SlackClient;
const slack = new WebClient(process.env.SLACK_TOKEN);

firebase.initializeApp({
  credential: firebase.credential.cert(serviceAccount),
  databaseURL: 'https://parpaing-e3e5c.firebaseio.com',
});

const store = firebase.firestore();
store.settings({
  timestampsInSnapshots: true,
});

// get slack users and insert them into firestore if they don't already exist
const initUserStore = async () => {
  (await slack.users.list()).members.forEach(async user => {
    const userRef = store.collection('users').doc(user.id);
    if (!(await userRef.get()).exists) {
      console.info(`[ADDED] ${user.id} : ${user.name}`);
      userRef.set({ ...user, score: 1 });
    }
  });
};

const getUser = userId =>
  store
    .collection('users')
    .doc(userId)
    .get();

const updateUserScore = async (userId, operation) => {
  const user = (await getUser(userId)).data();
  store
    .collection('users')
    .doc(userId)
    .set({ score: user.score + operation }, { merge: true });
};

const addToUserScore = (userId, amount) => updateUserScore(userId, amount);
const subtractToUserScore = (userId, amount) =>
  updateUserScore(userId, -amount);

(async function() {
  initUserStore();
})();

const throwRoute = post('/throw', async (req, res) => {
  const data = await parse(req);
  console.log(data);

  let reg = data.text.match(/<@([A-Z0-9]*)\|([a-zA-Z0-9]*)>/);
  if (!reg) {
    slack.chat.postMessage({
      channel: data.channel_id,
      text: `invalid request, no valid username could be found`,
    });
    return send(res, 200);
  }
  let toId = reg[1];
  let toName = reg[2];
  let fromName = data.user_name;
  let fromId = data.user_id;
  console.log(reg);

  if (!toId) {
    return `Who you're throwing a parpaing at?`;
  }
  if (!fromId) {
    return `Who send this?`;
  }

  const [fromUser, toUser] = await Promise.all([
    getUser(fromId),
    getUser(toId),
  ]);
  if (!fromUser.exists) {
    slack.chat.postMessage({
      channel: data.channel_id,
      text: `user ${fromName} does not exists`,
    });
    return send(res, 200);
  } else if (!toUser.exists) {
    slack.chat.postMessage({
      channel: data.channel_id,
      text: `user ${toName} does not exists`,
    });
    return send(res, 200);
  }

  slack.chat
    .postMessage({
      channel: toId,
      text: `${fromName} is throwing a parpaing at you`,
    })
    .then(answer => console.log(answer));

  updateUserScore(fromId, -1);
  updateUserScore(toId, 1);

  send(res, 200, `You throwed a parpaing at ${toName}`);
});

const checkRoute = post('/check', async (req, res) => {
  const data = await parse(req);
  console.log(data);
  let fromName = data.user_name;
  let fromId = data.user_id;
  let user = await getUser(fromId);

  send(res, 200, `You have ${user.data().score} parpaings`);
});

const homeRoute = get('/', async (req, res) => {
  console.log(req);
  send(res, 200, 'OK');
});

const routes = router(throwRoute, checkRoute, homeRoute);
const server = micro(routes);

server.listen(3000);
