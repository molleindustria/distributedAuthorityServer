
//load secret config vars
require("dotenv").config();

//.env content
/*
ADMINS=username1|pass1,username2|pass2
PORT = 3000
*/

//the port is defined by the env variable PORT, if undefined defaults to 3000
var PORT = process.env.PORT || 3000;
//3000 for localhost and glitch, 5000 for heroku

var ACTIVITY_TIMEOUT = 5 * 60 * 1000;
//cap the overall players 
var MAX_PLAYERS = 30;
//open to new arrivals
var OPEN = true;

//create a web application that uses the express frameworks and socket.io to communicate via http (the web protocol)
var express = require('express');
var app = express();
var fs = require("fs");
var http = require('http').createServer(app);
var io = require('socket.io')(http, { 'pingInterval': 2000, 'pingTimeout': 5000 });
//add this parameter to disconnect a socket after 5 second of no response

var Filter = require("bad-words");

//the id of the player with authority
var authority = "";

//netobject types, must match the clients'
var TEMPORARY = 0;
var PRIVATE = 1;
var SHARED = 2;
var PERSISTENT = 3; //not implemented yet

var admins = [];
if (process.env.ADMINS != null)
    admins = process.env.ADMINS.split(",");

//The game state object
var gameState;
//see if there is a database
if (fs.existsSync("db.json")) {
    print("Loading game state...");
    let rawdata = fs.readFileSync('db.json');
    //parse it as the gameState
    if (rawdata != null) {
        gameState = JSON.parse(rawdata);
    }
}

//db doesn't exists create an empty state and the file
if (gameState == null) {
    print("No Game State found. Creating an empty one...");
    //no db
    gameState = {
        players: {},
        objects: {},
        UNIQUE_ID: 0
    }
    //UNIQUE_ID, is a simple counter to ensure unique identifiers for net object "o1" "o2" etc
    fs.writeFileSync("db.json", JSON.stringify(gameState), "utf8");
}

//when a client connects serve the static files in the public directory ie public/index.html
app.use(express.static('public'));

//when a client connects 
io.on('connection', function (socket) {
    //this appears in the server's terminal
    console.log('A user connected');

    //this is sent to the client 
    //socket.emit('message', { id:"server", message: "Server says: HELLO!" });

    
    //when a client disconnects I have to delete its player object
    //or I may end up with ghost players

    //the "disconnect" event appears unreliable so I made a custom event on unity quit.
    //the same function is called for both events

    socket.on('disconnect', function (data) { userLeft(socket, data); });

    socket.on('quit', function (data) { userLeft(socket, data); });

    //joins the game after character creation
    socket.on('join', function (data) {
       
        //create player object
        gameState.players[socket.id] = {}
    
        //if nobody is the boss make them the boss
        if (authority == "") {
            authority = socket.id;
        }


        //send the new player the game state as a list of instantiations
        //with a lot of objects it may be problematic to fire them at the same time
        //print("Sending instantiations: " + Object.keys(gameState.objects).length + " netobjects");

        //send all the player data specifically the information about the avatar
        //which will be on the client before the avatar is instantiated as netobject
        //the position will be managed below by netobjects
        for (var o in gameState.players) {
            //NOT myself, 
            if (o != socket.id) {
                var data = gameState.players[o];
                if (data.id != undefined) {
                    //console.log(o + " sending " + data.id + " " + data.nickName);
                    socket.emit('addPlayerData', data);
                }
            }
        }


        for (var o in gameState.objects) {
            
            //instantiation data is stored in the server
            var data = gameState.objects[o];
            //this object has no owner, it may be because there are no other players
            //assign it to this one
            if (data.owner == "")
                data.owner = socket.id;

            socket.emit('instantiate', data);

            if (data.netVariables != null)
                socket.emit('setVariables', data.netVariables);
        }

        socket.emit('setAuthority', { id: authority });

        console.log("There are now " + Object.keys(gameState.players).length + " players");
    });

    //player instantiates a networked object, send info to everybody including creator
    socket.on('instantiate', function (data) {
        //server keeps track of unique ids
        data.uniqueId = "o" + gameState.UNIQUE_ID;
        gameState.UNIQUE_ID++;
        //anti-hack: the server writes the owner
        data.owner = socket.id;
        //save the object information, prefab, owner, transform etc
        gameState.objects[data.uniqueId] = data;
        io.sockets.emit('instantiate', data);
    });

    //player instantiates an avatar, which is a networked object to everybody 
    //except for the owner who controls it, avatars use socket name as unique id
    socket.on('instantiateAvatar', function (data) {
        data.uniqueId = socket.id;
        //anti-hack: the server writes the owner
        data.owner = socket.id;

        gameState.objects[data.uniqueId] = data;
        //to others an avatar looks like a net object
        socket.broadcast.emit('instantiate', data);
    });

    //player found a netObject already present in the unity scene without an owner
    //make sure its data is stored here
    socket.on('registerObject', function (data) {

        var o = gameState.objects[data.uniqueId];
        //never heard of this thing
        if (o == null) {

            print("Orphan Static object " + data.uniqueId);
            //assign the discoverer as owner
            data.owner = socket.id;
            //save the object information, prefab, owner, transform etc
            gameState.objects[data.uniqueId] = data;
            //send it to instantiate, if already there the instantiation will be skipped and only the transforms applied
            io.sockets.emit('instantiate', data);

            if (data.netVariables != null)
                socket.emit('setVariables', data);
        }
    });


    //player requests a change of ownership
    socket.on('requestOwnership', function (data) {
        var o = gameState.objects[data.uniqueId];

        if (o != null) {

            //double check that the ownership can be transfered
            if (o.type == SHARED || o.type == PERSISTENT) {
                o.owner = socket.id;
                io.sockets.emit('changeOwner', { uniqueId: data.uniqueId, owner: socket.id });
            }
        }
        else {
            print("ERROR on changeOwner: the netobject " + o.uniqueId + " doesn't exist");
        }
    });

    //player attempts to destroy a netObject
    socket.on('destroy', function (data) {
        var o = gameState.objects[data.id];
        //it exists and it comes from the owner 
        if (o != null)
            if (o.owner == socket.id) {
                io.sockets.emit('destroy', { id: data.id }); //I only need to send the object id
            }
    });

    //change netobject type request
    socket.on('changeType', function (data) {
        var o = gameState.objects[data.uniqueId];

        //double check that the requester is the owner
        if (o != null)
            if (o.owner == socket.id) {
                //ok, pass it 
                io.sockets.emit('changeType', data);
            }
    });

    //generic variable change
    socket.on('setVariables', function (data) {
        var o = gameState.objects[data.uniqueId];

        //double check that the requester is the owner and the object can be manipulated
        if (o != null)
            if (o.owner == socket.id) {
                //copy the non null variables and send them down 
                for (var v in data) {

                    if (data[v] != null)
                        gameState.objects[data.uniqueId].netVariables[v] = data[v];
                    //else
                    //    print("Here it is!");
                }

                gameState.objects[data.uniqueId].netVariables = data;

                io.sockets.emit('setVariables', gameState.objects[data.uniqueId].netVariables);
                gameState.players[socket.id].lastActivity = new Date().getTime();
            }
    });

    socket.on('netFunction', function (data) {
        var o = gameState.objects[data.objectName];
        //double check that the requester is the owner and the object can be manipulated
        if (o.owner == socket.id)
            io.sockets.emit('netFunction', data);
    });

    //players changes the transform of a net object
    socket.on('updateTransform', function (data) {


        var obj = gameState.objects[data.uniqueId];


        if (obj != null) {
            obj.position = data.position;
            obj.rotation = data.rotation;
            obj.localScale = data.localScale;
        }

        gameState.players[socket.id].lastActivity = new Date().getTime();

        //broadcast the change
        socket.broadcast.emit('updateTransform', data);

    });

    //players is connected and sends avatar data which is then broadcast if valid
    socket.on('avatarData', function (data) {

        var val = 1;

        val = validateName(data.nickName);

        if (val != 1 && val != 2) {
            socket.emit("nameError", {num:val});
        }
        else if (OPEN == false && val != 2) {
            socket.emit("message", { id: "server", message: "SORRY THE SPACE IS CLOSED. TRY AGAIN LATER." });
            socket.disconnect();
        }
        else {

            
            //if there is an | strip the after so the password remains in the admin client
            var combo = data.nickName.split("|");
            nickName = combo[0];
            nickName = filter.clean(nickName);

            console.log("New player " + nickName + " sent avatar data ");
            //adding id just in case
            data.id = socket.id;

            gameState.players[socket.id] = data;
            gameState.players[socket.id].nickName = nickName;
            gameState.players[socket.id].admin = (val == 2);
            gameState.players[socket.id].muted = false;
            gameState.players[socket.id].lastActivity = new Date().getTime();

            if (val == 2)
                console.log(nickName + " joins as admin");

            //if nobody is the boss make them the boss
            if (authority == "") {
                authority = socket.id;
            }

            //send the new player the game state as a list of instantiations
            //with a lot of objects it may be problematic to fire them at the same time
            //print("Sending instantiations: " + Object.keys(gameState.objects).length + " netobjects");

            //send all the player data specifically the information about the avatar
            //which will be on the client before the avatar is instantiated as netobject
            //the position will be managed below by netobjects
            for (var o in gameState.players) {
                //NOT myself, 
                if (o != socket.id) {
                    var otherData = gameState.players[o];
                    if (otherData.id != undefined) {
                        //console.log(o + " sending " + otherData.id + " " + otherData.nickName);
                        socket.emit('addPlayerData', otherData);
                    }
                }
            }

            for (var o in gameState.objects) {
                //instantiation data is stored in the server
                var objectData = gameState.objects[o];
                //this object has no owner, it may be because there are no other players
                //assign it to this one
                if (objectData.owner == "")
                    objectData.owner = socket.id;

                socket.emit('instantiate', objectData);
                
                if (objectData.netVariables != null) {
                    socket.emit('setVariables', objectData.netVariables);
                }
            }

            socket.emit('setAuthority', { id: authority });

            io.sockets.emit('playerJoin', data);

            console.log("There are now " + Object.keys(gameState.players).length + " players");
        }
    });

    //change netobject type request
    socket.on('message', function (data) {
        data.id = socket.id;
        //Admin commands can be typed as messages
        //is this an admin
        data.message = data.message.replace(/[^A-Za-z0-9_!$%*()@./#&+-|]*$/g, "");

        //remove leading and trailing whitespaces
        data.message = data.message.replace(/^\s+|\s+$/g, "");
        //filter bad words
        data.message = filter.clean(data.message);
        //advanced cleaning

        //f u c k
        var test = data.message.replace(/\s/g, "");
        //fffffuuuuck
        var test2 = data.message.replace(/(.)(?=.*\1)/g, "");
        //f*u*c*k
        var test3 = data.message.replace(/\W/g, "");
        //spaces
        var test4 = data.message.replace(/\s/g, "");

        var test5 = false;

        for (var i = 0; i < myBadWords.length; i++) {
            var lowered = test.toLowerCase();

            if (lowered.includes(myBadWords[i].toLocaleLowerCase())) {
                test5 = true;
            }
        }

        if (filter.isProfane(test) || filter.isProfane(test2) || filter.isProfane(test3) || test4 == "" || test5) {
            console.log(socket.id + " is problematic");
        }
        else {

            if (gameState.players[socket.id].admin && data.message.charAt(0) == "/") {
                console.log("Admin " + gameState.players[socket.id].nickName + " attempts command " + data.message);
                adminCommand(socket, data.message);
            }
            else if (!gameState.players[socket.id].muted) {

                io.sockets.emit('message', data);
                gameState.players[socket.id].lastActivity = new Date().getTime();
            }
        }

    });


    if (Object.keys(gameState.players).length >= MAX_PLAYERS && MAX_PLAYERS != -1) {
        print("ATTENTION MAXIMUM PLAYERS REACHED");
        socket.emit("message", { id: "server", message: "SORRY THE SERVER IS FULL. TRY AGAIN LATER." });
        //socket.disconnect();
    }
    else {
    //sends the new player a confirmation of the socket connection
    socket.emit('socketConnect', { num: Object.keys(gameState.players).length });
    }

});//end of connected client


function userLeft(socket, data) {

    console.log("User disconnected - destroying player " + socket.id);

    io.sockets.emit('playerDisconnect', { id: socket.id });

    //delete the player object
    delete gameState.players[socket.id];

    //if this was the boss make someone else the boss
    if (authority == socket.id) {
        var keys = Object.keys(gameState.players);

        authority = "";
        if (keys.length > 0)
            authority = keys[keys.length * Math.random() << 0];

        io.sockets.emit('setAuthority', { id: authority });
    }

    //the networked objects need an "owner" that keep tracks of their properties
    //when a player leaves the game I go through all the netobjects and reassign the orphans to another player
    //based on the type
    for (var o in gameState.objects) {
        //is this disconnected player the owner of the object?
        if (gameState.objects[o].owner == socket.id) {

            //temporary -> destroy
            if (gameState.objects[o].type == TEMPORARY) {

                io.sockets.emit('destroy', { id: o }); //I only need to send the object id
                //delete from my records
                delete gameState.objects[o];
            }
            else {
                //in every other case 
                //pick an inherithor of the orphan objects
                var keys = Object.keys(gameState.players);
                var newOwner = "";
                if (keys.length > 0)
                    newOwner = keys[keys.length * Math.random() << 0];

                gameState.objects[o].owner = newOwner;
                io.sockets.emit('changeOwner', { uniqueId: gameState.objects[o].uniqueId, owner: newOwner });
            }
        }
    }

    //PERSISTENCE 
    //if the last player leaves the game the server may shut down, so save the game state
    if (Object.keys(gameState.players).length == 0) {

        //go through the objects and delete the non persistent ones
        for (var o in gameState.objects) {
            if (gameState.objects[o].type != PERSISTENT) {
                delete gameState.objects[o];
            }
        }

        saveState();
    }

    console.log("There are now " + Object.keys(gameState.players).length + " players");
}

//listen to the port 3000
http.listen(PORT, function () {
    console.log('listening on *:' + PORT);
});

//saveState simply writes down a copy of the gameState object as a JSON text file
//This solution does NOT scale if you have a lot of persistent objects.
//For bigger, persistent project you want to use an actual database like MongoDB (cloud hosted and JSON friendly)
function saveState() {
    print("Last player left. Saving Game state...");
    fs.writeFileSync("db.json", JSON.stringify(gameState), "utf8");

}


function validateName(nn) {

    var admin = false;
    var duplicate = false;
    var reserved = false;
    var wrongPassword = false;
    var empty = false;

    if(nn.trim() == "")
        empty = true;

    //check if the nickname is a name + password combo
    var nnCombo = nn.split("|");

    //it may be
    if (nnCombo.length > 1) {
        var n = nnCombo[0].trim();
        var p = nnCombo[1].trim();

        for (var i = 0; i < admins.length; i++) {
            
            var envCombo = admins[i].split("|");
            
            if (envCombo[0].toUpperCase() == n.toUpperCase()) {
                //it is an admin name! check if the password is correct, case insensitive 
                print("it is an admin name! check if the password is correct, case insensitive")
                if (envCombo[1].toUpperCase() == p.toUpperCase()) {
                    admin = true;
                }
                else {
                    wrongPassword = true;
                    print("Wrong pass");
                }
            }
        }
        //if there is an | just strip the after
        nn = n;
    }

    //if not admin check if the nickname is reserved (case insensitive)
    if (!admin) {
        for (var i = 0; i < admins.length; i++) {
            var combo = admins[i].split("|");
            if (combo[0].toUpperCase() == nn.toUpperCase()) {
                //it is! kill it. Yes, it should be done at login and communicated 
                //but hey I don't have to be nice to users who steal my name
                reserved = true;
            }
        }
    }

    var id = idByName(nn);
    if (id != null) {
        duplicate = true;
        console.log("There is already a player named " + nn);
    }

    //i hate this double negative logic but I hate learning regex more
    var res = nn.match(/^([a-zA-Z0-9 !@#$%&*(),._-]+)$/);

    if(empty)
        return 5
    if(wrongPassword)
        return 4
    else if (res == null)
        return 3
    else if (duplicate || reserved)
        return 0
    else if (admin) {
        console.log(nn + " logging as admin");
        return 2
    }
    else
        return 1
}


function idByName(nick) {
    var i = null;
    for (var id in gameState.players) {
        if (gameState.players.hasOwnProperty(id))
            if (gameState.players[id].nickName != null) {
                if (gameState.players[id].nickName.toUpperCase() == nick.toUpperCase()) {
                    i = id;
                }
            }
    }
    return i;
}


//admin functions, the admin exists in the client frontend so they don't have access to ip and id of other users
function socketByName(nick) {
    var s = null;
    for (var id in gameState.players) {
        if (gameState.players.hasOwnProperty(id)) {

            if (gameState.players[id].nickName.toUpperCase() == nick.toUpperCase()) {
                s = io.sockets.sockets[id];
            }
        }
    }
    return s;
}


//parse a potential admin command
function adminCommand(adminSocket, str) {
    try {
        //remove /
        str = str.substr(1);
        var cmd = str.split(" ");

        switch (cmd[0].toLowerCase()) {
            case "kick":
                var s = socketByName(cmd[1]);
                if (s != null) {
                    //shadow disconnect
                    s.disconnect();

                }
                else {
                    //popup to admin
                    //socket.emit('message', { id:"server", message: "Server says: HELLO!" });
                    adminSocket.emit("message", { id: "server", message: "I can't find a user named " + cmd[1] });
                }
                break;

            case "mute":
                var s = idByName(cmd[1]);
                if (s != null) {
                    gameState.players[s].muted = true;
                }
                else {
                    //popup to admin
                    adminSocket.emit("message", { id: "server", message: "I can't find a user named " + cmd[1] });
                }
                break;

            case "unmute":
                var s = idByName(cmd[1]);
                if (s != null) {
                    gameState.players[s].muted = false;
                }
                else {
                    //popup to admin
                    adminSocket.emit("message", { id: "server", message: "I can't find a user named " + cmd[1] });
                }
                break;

            //triggers a message on everybody
            case "god":

                cmd.shift();
                var msg = cmd.join(" ");
                io.sockets.emit("message", { id: "server", message: msg });

                break;


            //disconnect all sockets
            case "nuke":

                for (var id in io.sockets.sockets) {
                    //io.sockets.sockets[id].emit("errorMessage", "Server Restarted\nPlease Refresh");
                    io.sockets.sockets[id].disconnect();
                }
                break;

            case "open":
                OPEN = true;
                adminSocket.emit("message", { id: "server", message: "Opening to new players" });
                break;

            case "close":
                OPEN = false;
                adminSocket.emit("message", { id: "server", message: "Closing to new players" });
                break;

            case "players":
                adminSocket.emit("message", { id: "server", message: Object.keys(gameState.players).length + " players connected" });
                break;

        }
    }
    catch (e) {
        console.log("Error admin command");
        console.error(e);
    }
}


//check the last activity and disconnect players that have been idle for too long
setInterval(function () {
    var time = new Date().getTime();

    for (var id in gameState.players) {
        if (gameState.players.hasOwnProperty(id)) {
            if (gameState.players[id].admin == false)
                if (gameState.players[id].lastActivity == undefined || (gameState.players[id].nickName != "" && (time - gameState.players[id].lastActivity) > ACTIVITY_TIMEOUT)) {
                    console.log(id + " has been idle for more than " + ACTIVITY_TIMEOUT + " disconnecting");
                    //io.sockets.sockets[id].emit("refresh");
                    io.sockets.sockets[id].disconnect();
                }
        }
    }
}, 1000);


//in my gallery people can swear but not use slurs, override bad-words list, and add my own, pardon for my french
let myBadWords = ["chink", "cunt", "cunts", "fag", "fagging", "faggitt", "faggot", "faggs", "fagot", "fagots", "fags", "jap", "homo", "nigger", "niggers", "n1gger", "nigg3r"];
var filter = new Filter({ emptyList: true });
filter.addWords(...myBadWords);


function print(m) {
    console.log(m);
}





