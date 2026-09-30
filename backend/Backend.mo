// thebes-poll — one-vote-per-identity polls on Thebes.
//
//   createPoll   ask a question with 2–4 options
//   vote         pick one option — once per poll, per identity
//   closePoll    stop voting (only the poll's creator)
//   listPolls    every poll + its vote counts      <- query
//   listOptions  every option of every poll        <- query
//   myVotes      which option the caller picked     <- query
//   myId         the caller's identity on the chain <- query
//   seal         whole-contract tally check         <- query
//
// The rule that makes this a blockchain app: `vote` reads `msg.caller` and
// refuses a second vote from the same identity. That check runs inside the
// contract on every validator, so no website or server can skip it.
//
// Two independent records are kept for every poll:
//   counts  — one number per option, bumped on each vote
//   voters  — who voted and for what
// They are written together, so they must always agree:
//   sum(counts) == number of voters
// `listPolls` and `seal` recompute that on every read — the tally checks itself.

import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Array "mo:core/Array";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Principal "mo:core/Principal";

persistent actor Backend {

  let MIN_OPTIONS : Nat = 2;
  let MAX_OPTIONS : Nat = 4;
  let MAX_QUESTION : Nat = 200;
  let MAX_OPTION : Nat = 80;

  type Poll = {
    id : Nat;
    question : Text;
    options : [Text];
    counts : [Nat];
    creator : Principal;
    createdAt : Int;
    closed : Bool;
  };

  // What the frontend reads. The SDK decodes flat records only, so options
  // travel separately (see OptionView) instead of as an array inside a poll.
  public type PollView = {
    id : Nat;
    question : Text;
    creator : Text;
    createdAt : Int;
    closed : Bool;
    totalVotes : Nat;
    voters : Nat;
    verified : Bool;
  };

  public type OptionView = {
    pollId : Nat;
    index : Nat;
    text : Text;
    votes : Nat;
  };

  public type MyVote = {
    pollId : Nat;
    index : Nat;
  };

  var nextPollId : Nat = 0;
  let polls = Map.empty<Nat, Poll>();
  // pollId -> (voter -> option index)
  let voters = Map.empty<Nat, Map.Map<Principal, Nat>>();

  func pollVoters(pollId : Nat) : Map.Map<Principal, Nat> {
    switch (Map.get(voters, Nat.compare, pollId)) {
      case (?m) m;
      case null Map.empty();
    };
  };

  func sum(xs : [Nat]) : Nat {
    var total : Nat = 0;
    for (x in xs.vals()) { total += x };
    total
  };

  func clean(t : Text) : Text { Text.trim(t, #char ' ') };

  func view(p : Poll) : PollView {
    let totalVotes = sum(p.counts);
    let voterCount = Map.size(pollVoters(p.id));
    {
      id = p.id;
      question = p.question;
      creator = Principal.toText(p.creator);
      createdAt = p.createdAt;
      closed = p.closed;
      totalVotes;
      voters = voterCount;
      verified = totalVotes == voterCount;
    }
  };

  // ── who am I ───────────────────────────────────────────────────────────

  public query (msg) func myId() : async Text {
    Principal.toText(msg.caller)
  };

  // ── writes (these go through consensus) ────────────────────────────────

  // Replies are Text so the terminal shows them as-is. Success always starts
  // with "Created" / "Vote counted" / "Closed" — the frontend relies on that.
  public shared (msg) func createPoll(question : Text, options : [Text]) : async Text {
    let q = clean(question);
    if (q.size() == 0) return "The question cannot be empty";
    if (q.size() > MAX_QUESTION) return "The question is too long (max " # Nat.toText(MAX_QUESTION) # " characters)";

    let opts = Array.map<Text, Text>(options, clean);
    if (opts.size() < MIN_OPTIONS or opts.size() > MAX_OPTIONS) {
      return "A poll needs " # Nat.toText(MIN_OPTIONS) # " to " # Nat.toText(MAX_OPTIONS) # " options";
    };
    for (o in opts.vals()) {
      if (o.size() == 0) return "Options cannot be empty";
      if (o.size() > MAX_OPTION) return "An option is too long (max " # Nat.toText(MAX_OPTION) # " characters)";
    };

    let id = nextPollId;
    nextPollId += 1;
    Map.add(polls, Nat.compare, id, {
      id;
      question = q;
      options = opts;
      counts = Array.repeat<Nat>(0, opts.size());
      creator = msg.caller;
      createdAt = Time.now();
      closed = false;
    });
    "Created poll #" # Nat.toText(id)
  };

  public shared (msg) func vote(pollId : Nat, index : Nat) : async Text {
    let p = switch (Map.get(polls, Nat.compare, pollId)) {
      case null return "Poll not found";
      case (?p) p;
    };
    if (p.closed) return "This poll is closed";
    if (index >= p.options.size()) return "That option does not exist";

    // THE rule: one vote per identity, checked before anything changes.
    let who = pollVoters(pollId);
    switch (Map.get(who, Principal.compare, msg.caller)) {
      case (?_) return "You already voted in this poll";
      case null {};
    };

    Map.add(who, Principal.compare, msg.caller, index);
    Map.add(voters, Nat.compare, pollId, who);
    Map.add(polls, Nat.compare, pollId, {
      p with counts = Array.tabulate<Nat>(
        p.counts.size(),
        func(i) { if (i == index) p.counts[i] + 1 else p.counts[i] },
      )
    });
    "Vote counted for \"" # p.options[index] # "\""
  };

  public shared (msg) func closePoll(pollId : Nat) : async Text {
    let p = switch (Map.get(polls, Nat.compare, pollId)) {
      case null return "Poll not found";
      case (?p) p;
    };
    if (not Principal.equal(p.creator, msg.caller)) return "Only the poll's creator can close it";
    if (p.closed) return "Closed already";
    Map.add(polls, Nat.compare, pollId, { p with closed = true });
    "Closed poll #" # Nat.toText(pollId)
  };

  // ── reads (queries: one node answers, instantly) ───────────────────────

  public query func listPolls() : async [PollView] {
    Iter.toArray(Iter.map(Map.values(polls), view))
  };

  public query func listOptions() : async [OptionView] {
    let out = List.empty<OptionView>();
    for (p in Map.values(polls)) {
      for (i in p.options.keys()) {
        List.add(out, { pollId = p.id; index = i; text = p.options[i]; votes = p.counts[i] });
      };
    };
    List.toArray(out)
  };

  public query (msg) func myVotes() : async [MyVote] {
    let out = List.empty<MyVote>();
    for ((pollId, who) in Map.entries(voters)) {
      switch (Map.get(who, Principal.compare, msg.caller)) {
        case (?index) List.add(out, { pollId; index });
        case null {};
      };
    };
    List.toArray(out)
  };

  // The law, recomputed on every read, across every poll.
  public query func seal() : async Text {
    var votes : Nat = 0;
    var ballots : Nat = 0;
    for (p in Map.values(polls)) {
      votes += sum(p.counts);
      ballots += Map.size(pollVoters(p.id));
    };
    "polls " # Nat.toText(Map.size(polls))
      # "  ·  votes counted " # Nat.toText(votes)
      # "  ·  ballots on record " # Nat.toText(ballots)
      # "  ·  " # (if (votes == ballots) "OK" else "BROKEN")
  };
};
