# Distributed Authority Multiplayer Framework for Unity

This is an example of multiplayer architecture with "smart" clients. 
The clients (Unity) do most of the work; the server (node.js) mostly validates and broadcast the changes of state.

The client's source is [in a different repository](https://github.com/molleindustria/distributedAuthorityClient).

This architecture involves "networked objects" that are tracked by an individual client referred to as "owner". 

The client includes a scene with a character customization menu and animated humanoid avatars and one scene without menus and animation. 

Note: This framework is for educational purposes. 
It is the simplest, most flexible architecture I could think of. It's designed for clarity and hackability. It's not optimized and it and won't probably scale for bigger projects. The goal is to allow students to focus on multiplayer game logic only on the client side and without having to use arcane programming patterns.

Key concepts and related Unity Scripts:

## NetObject.cs

This script can be attached to any object that needs to be syncronized across clients. The synchonization of the Transform (position, rotation, localScale) is automatic. 

### Ownership
Each NetObject has a unique "owner" which is a player's client that keeps track of the changes and sends them to the server for broadcast. The owner system prevents misalignments across clients. Ownership can change according to the object type. A client that needs to interact with an NetObject has to request ownership first with `Net.RequestOwnership(string uniqueId)`. The ownership should be automatically granted if the type allows it, see below. 

### Type
A NetObject has a type property (int) that defines if the ownership can change what happens when the owner disconnects. The types are:

* TEMPORARY: the ownership can't be transfered and the object disappears when the player disconnects. It can be used for avatars which are exclusively controlled by the player, or non permanent things like speech bubbles or visual effects.

* PRIVATE: private as in private property. The ownership can't be transfered during the game but it is automatically reassigned when the player disconnects. The object sticks around until it's destroyed or the server restarts.

* SHARED: any client can request the object's ownership. The ownership is automatically reassigned when the player disconnects. The object sticks around until it's destroyed or the server restarts.

* PERSISTENT: Like SHARED except the object persist even if the server restarts. The information is stored in a file when the last player leaves the server. Objects that are part of the Unity scene, ie it's not dynamically instantiated, are automatically set as PERSISTENCE.

An owner can change the type of an object with `Net.ChangeType(string objectId, int type)`. 
Example: dropping a cube changes it from PRIVATE to SHARED allowed other players to pick it up. 

### Instantiating NetObjects
NetObjects can be dynamically instantiated from prefabs in the **Resources** folder. The name of the prefab remains stored in the NetObject script allowing you to differentiate between different NetObjects without complicated subclasses.

```Net.Instantiate(string prefabName, int type, Vector3 position, Quaternion rotation, Vector3 localScale)```

Net.Instantiate creates an instance of the object in each connected client, the server stores a copy of that information to send to newly connected clients. The object is automatically given an unique identifier *uniqueId* by the server.

Similarily Net.Destroy destroys the object on all the clients.

## NetVariables.cs
NetObjects come with a set of variables that are syncronized across clients. Due to Unity's variable type rigidity we need to define a *Serializable* data structure for them, which is basically a custom class with some properties. You can modify NetVariables.cs to add your own variables.
The NetVariables only propagate when they are **set** with the function:

```Net.SetVariables(string uniqueId, NetVariables netVars)```

The NetObject needs to be told that one or more variables changed in order to sent an update to the server, which in turn will store the values and update the other clients.
The NetObject will then invoke **OnVariableChange** which allows each client to do something in response to this change.

Eg: Clicking on a "Cube" NetObject randomly changes the variable exampleVar, OnVariableChange changes the color of the material. Since all the NetVariables are stored by the server, this change will be visible even by the client that connect *after* the color change.

## NetManager.cs
This script works in tandem with **SocketIOController** and should be attached to the same object. It contains all the functions that interact with the server and the *serializable* classes that allow communication over sockets via JSON.

Ideally, you would consider NetManager.cs a black box that just works. Realistically, you may need to modify it for use cases that I didn't predict. 

Netmanager stores the server settings: url, port, ssl. There are 3 presets to quickly switch between localhost, glitch and heroku  

### Avatars
NetManager.cs can create avatars automatically. You just need to specify:
**MyAvatarPrefabName**: the name of the prefab in **Resources**. It typically contains the player controls.
**OtherAvatarPrefabName**: the name of the prefab in **Resources** that will represent other players. It should not have player controls associated to it.

The avatars are basically TEMPORARY NetObjects that are created and destroyed upon connections and disconnections.
If no avatar names are specified, the player and sockets will still be created but without any object associated. 
Eg. an RTS doesn't require avatars.

## Net.cs
This is a *static* class, it means that it's visible from all the components and it doesn't need to be attached to an object. It stores some global variables, plus alias and overloads of functions located in NetManager.cs. 
Some useful properties and methods:

* **Net.players**: a local *dictionary* of Player objects, similar to the one on the server. A dictionary is an array of objects accessed with a string, a bit like in javascript (`Net.players["playerId"]`). Player objects are not used in this basic example but they can be useful for actual games.

* **Net.objects**: a local *dictionary* of NetObject references. The reference is to the NetObject scripts and you can access the Unity gameObject with `Net.objects["objectId"].gameObject`.

* **Net.myId**: the id of the client. It's the same as the socket id and the avatar gameObject name. It's an unguessable unique string like `iPw6_bs5vNd9illwAAAK`

* **Net.connected**: *true* if the client is connected to the server. The connection is not immediate and you don't want to call socket functions before the Net.connected is true or it may crash the client.

* **Net.authority**: *true* if the client is the current authority (see below)

### Net.Function
A method in **Net.cs** that allows you to call the same function on all clients.

``Net.Function(string objectName, string componentName, string functionName, string argument)``

Every client looks for "objectName", fetches the script or component "componentName", and calls the method "functionName" with a string argument (optional when called). The function needs to be public and have a sting as argument. eg `public void CustomFunction(string arg) { }`

NetFunctions can be used for core game events and momentary events like sounds. Note: the effects of a NetFunction are not stored in the server unless they affect NetVariables.

### Net.authority

This architecture can have server-authoritative logic in that the server can invoke NetFunctions and other events that are not originated by the client. However the server is not "smart" and doesn't know most of the state of the game. For example it doesn't know when two objects collide.

The problem with client originated-events is that they can be conflicting and unnecessarily duplicated. 
eg: a collision produces a crucial gameplay event like a score or a kill. The collision is resolved by a standard unity **OnCollisionEnter** but since it happens in all clients with different lags, it can produce duplicate or even conflicting kills or scoring. 

One way to deal with it is to use the **Net.authority** boolean which is automatically assigned to one and only one client in the game.
The aforementioned score and the kill event will be broadcast only by the client with Net.authority set to true.

Note: The human player doesn't need to know they are the authority, it's not the same as "hosting a game". If the authority client disconnects the server automatically reassigns the authority to another random player.

## db.json and persistence

The gameState with all the PERSISTENT NetObjects is saved in a json file when the last player disconnects.
This is a very basic solution and it does NOT scale if you have a lot of persistent objects. For bigger, persistent world you want to use an actual database like MongoDB (cloud hosted and JSON friendly) and structure your world is separate servers and areas.

You can get rid of all the persistent data by simply deleting db.json. An empty one will be recreated at the next server restart.


## Other Assets

The template includes other scripts you are expected to modify such as: 

### GameMenu.cs

Manages the character creation and the game state before joining. If not referenced in NetManager, the game starts without name validation and avatar data.

### Appearance.cs

Attached to all avatars, it translates a player's DNA (an array of float storing traits) into properties of the game object. In the "Client" example, all interchangeable heads are included in the prefab and this script disables the ones that don't correspont to the head index.

### AnimationManager.cs

Handles the animations based on the delta position, an easy way to avoid sending animation data.

### FirstPersonInteraction.cs

Contains examples for several features such as instantiating net objects.

### CameraFollow.cs, BallBehavior.cs, FirstPersonController.cs, TwinStickController.cs

They are common Unity scripts that have no impact on the framework



# Setup
In js and node.js projects, the source code *is* the code that gets deployed. Unity projects don't work this way. You will not run or upload the client source project (the folder you open in the Unity editor), rather you will create a *build* for the client's operating system: Windows, Mac or WebGL (browser).

My recommendation is to use VS Code for the server side (node.js) and Visual Studio for the Unity side to compartimentalize these two environments. 

All clients should run the same code so you need to rebuild, close and reopen the executables every time there is a significant change.

### Testing locally

* Clone and download this repository. 
* Open it in VS Code 
* Run npm install to install the dependencies
* run ```node server.js``` or ```nodemon server.js```
* Open different tabs and point them to localhost
You should see the WebGL build that comes with this repository

### Building an executable client
* Download the [client repository](https://github.com/molleindustria/distributedAuthorityClient). That is not a full unity project, it only includes the Assets.
* Create a new unity project and import the client assets
* Test it locally and in the editor first
* Build an executable for your system File > build settings > Build
* On MacOS you can't open multiple copies (instances) of the same program by double clicking, you have to open the terminal at the folder and launch the app with the -n parameter: ```open -n game.app```
* On Windows you may have to hold *shift* when double clicking on the executable

You should see the game networking locally and even communicating between Unity editor, executable, and browser builds. 

**Note:** For testing purposes it's a good idea to build the project as windowed (and not fullscreen, which is default) and resizable so you can easily swap between instances. Edit > Project settings > Player.


### Building a WebGL client
Javascript is primarily meant for browser applications while Unity is mostly used for desktop and mobile. 
However Unity can build for WebGL if you install the proper component. It's just a bit more awkward.

* socket.io requires a library on client side to work. Since it's not a standard Unity feature you will need to include it in a custom [WebGL template](https://docs.unity3d.com/Manual/webgl-templates.html) which is the html page that embeds the game.
You'll find two template in the Assets folder of the client under *WebGLTemplates*. You can modify them like normal html.
The templates simply include this line that points to the library the root folder of the server:
`<script src="/socket.io/socket.io.js"></script>`

Make sure you select the template that matches your version since Unity 2019 and 2020 are different:
*Unity > Project settings > Player > WebGL (html5 icon) > Resolution and Presentation > WebGL template*

* Switch to WebGL: *file > build, switch to WebGL > wait a few minutes*. 

* **Make sure your server.js is not currently running** otherwise Unity may not be able to overwrite.

* Make sure add the current scene is added and hit build. 
You want to build it into the *public* folder of this project so that index.html is directly in the public folder (not a subfolder. Point to the current "public" and overwrite.
You can find more info [here](https://docs.unity3d.com/Manual/webgl-building.html).


## Networking with Glitch
You can use Glitch to transfer data between clients even if the project isn't running on a browser.

* Clone this repository and import it from glitch.

* Make sure that the Unity client is pointing at your glitch address.
In the Unity Scene, on the SocketIO component of the Main change the url to your glitch address eg:

`testsocket.glitch.me`

Of course replace *testsocket* with your own url. Don't add http or slashes.

**The port number should be empty** if a port number is specified, glitch will refuse the connection. I don't know why.

Always keep in mind that Glitch projects go to sleep when inactive so they may require a minute or two to wake up.

**Check SSL Enabled** it's not necessary if you are testing it locally but if not checked it will cause issues with publishing online.


# Troubleshooting

* Unity compiling Error:
`UnauthorizedAccessException: Access to the path ...` 
Possible solution: Unity is trying to create a file in a folder in user. Make sure your server.js is not running locally CTRL+C / CMD+C.

* Unity runtime error:
`An error has occurred in sending data`
Possible solution: server.js is not running or crashed, fix the error there

* Browser says
`This site can’t be reached`
Possible solution: make sure server.js is running.
Make sure the ports on the browser URL, the PORT on server.js, and the port on socketIO controller are the same (eg 3000)

* On broswer the loading bar is stuck on 90%    
Possible solution: Unity > Project settings > Player > WebGL (html5 icon) tab at the bottom > Compression format > Disabled

* Browser console error:
`ReferenceError: io is not defined`
or
`error ERR_CONNECTION_REFUSED socket.io/socket.io.js`
Possible solution: it's probably the missing link to socket.io, Make sure that the webGL template is selected and that it corresponds to the right unity version

* Browser console error:
`VM206:1 GET https://localhost/socket.io/?EIO=3&transport=polling&t=NGnQ_L0 net::ERR_CONNECTION_REFUSED`
Possible solution: it's probably a secure connection issue. 
In Unity find socketIO controller on the scene, uncheck ssl enabled.
You may encounter the inverse error when you publish on a https domain, it may refuse connection 

* The client build works locally but not online (e.g. glitch) or viceversa. 
It's normal: the socket manager needs an url, a port, and an SSL/no SSL boolean, to connect. Glitch or heroku use slighly different settings that are hardcoded in the client build. Change them on the inspector of SocketIOController.cs or override them from NetManager, look for the "GLITCH" boolean for example.



# JSON and Serializing

socket.io transmits data via JSON, a text format that matches javascript object structures. Example:

```JSON
{
"stringVariableName":"Best game",
"numberVariable":100,
"playerIds":["zDHsXx9dq-UIeSo4AAAL"],
"players":[{"x":164.5037,"y":297.1719,"vX":0,"vY":0,"angle":0,"state":1,"counter":-1}]
}
```

However, while JS is dynamically typed, Unity always needs to know the variable types. Unity can parse a JSON string (ie: turn into an object) only if the data structure it contains is *serialized* as a Class. Basically, you need to create class that match the data you receive. See the classes at the very bottom of Main.cs.

Unity can't serialize *dictionary* variables, which is unfortunate because socket.io stores client information using id as properties and Dictionaries would come handy. You can see workaround in server.js and on the JSON snippet above: I'm tracking the player states with an array of id and a corresponding array of objects.