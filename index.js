const { router, post } = require("microrouter");
const parse = require("urlencoded-body-parser");
const { send } = require("micro");
const Slack = require("slack");
const bot = new Slack({
  token: process.env.SLACK_TOKEN
});

let users;

getUserFromId = id => users.filter(user => user.id === id)[0];
updateUserScore = (userId, operation) => {
  let user = getUserFromId(userId);
  user.score = user.score + operation;
};

(async function() {
  users = (await bot.users.list()).members.map(u => {
    u.score = 0;
    return u;
  });
  //   console.log(users);
})();

const throwRoute = async (req, res) => {
  const data = await parse(req);
  console.log(data);

  let reg = data.text.match(/<@([A-Z0-9]*)\|([a-zA-Z0-9]*)>/);
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

  let answer = await bot.chat.postMessage({
    channel: toId,
    text: `${fromName} is throwing a parpaing at you`
  });
  console.log(answer);

  updateUserScore(fromId, -1);
  updateUserScore(toId, 1);

  send(res, 200, await Promise.resolve(`You throwed a parpaing at ${toName}`));
};

const checkRoute = async (req, res) => {
  const data = await parse(req);
  console.log(data);
  let fromName = data.user_name;
  let fromId = data.user_id;

  send(
    res,
    200,
    await Promise.resolve(`You have ${getUserFromId(fromId).score} parpaings`)
  );
};

module.exports = router(post("/throw", throwRoute), post("/check", checkRoute));
