Hooks.once('init', async () => {
    const usingTheForge = typeof ForgeVTT != "undefined" && ForgeVTT.usingTheForge;

    game.settings.register("dragupload", "fileUploadSource", {
        name: "The path files should be uploaded to",
        scope: "world",
        config: !usingTheForge,
        type: String,
        default: usingTheForge ? "forgevtt" : "data",
        choices: {
          "data": game.i18n.localize("FILES.SourceUser"),
          "s3": game.i18n.localize("FILES.SourceS3"),
        },
        onChange: async () => { await initializeDragUpload(); }
    });

    game.settings.register("dragupload", "fileUploadFolder", {
        name: "The path files should be uploaded to",
        hint: "Should look like 'dragupload/uploaded'",
        scope: "world",
        config: true,
        type: String,
        default: "dragupload/uploaded",
        onChange: async () => { await initializeDragUpload(); }
    });

    try {
        const buckets = await FilePicker.browse("s3", "");
        let bucketChoices = {};
        for ( let bucket of buckets.dirs ) {
            bucketChoices[bucket] = bucket;
        }
        game.settings.register("dragupload", "fileUploadBucket", {
            name: "If using S3, what S3 bucket should be used",
            scope: "world",
            config: !usingTheForge,
            type: String,
            default: usingTheForge ? "" : (FilePicker.S3_BUCKETS?.length > 0 ? FilePicker.S3_BUCKETS[0] : ""),
            choices: bucketChoices,
            onChange: async () => {
                await initializeDragUpload();
            }
        });
    }
    catch {}
});

Hooks.once('ready', async function() {
    // Setup variables and folders
    await initializeDragUpload();

    // Enable binding
    new DragDrop({
        callbacks: {
            drop: handleDrop
        }
    })
    .bind(document.getElementById("board"));
});

async function initializeDragUpload() {
    if (game.user.isGM || game.user.hasPermission(CONST.USER_PERMISSIONS.FILES_UPLOAD)) {
        await createFoldersIfMissing();
    }

    //const targetBucket = game.settings.get("dragupload", "fileUploadBucket");
    let folderParts = [];
    const targetFolder = game.settings.get("dragupload", "fileUploadFolder");
    folderParts = folderParts.concat(targetFolder.split("/")).filter(x => x!== "");

    window.dragUpload = {};
    window.dragUpload.targetFolder = folderParts.join("/");
}

async function createFoldersIfMissing() {
    const targetLocation = game.settings.get("dragupload", "fileUploadFolder");
    const targetLocationFolders = targetLocation.split("/").filter(x => x !== "");
    let pathParts = [];
    for ( const folder of targetLocationFolders ) {
        pathParts.push(folder);
        await createFolderIfMissing(pathParts.join("/"));
    }
    await createFolderIfMissing(pathParts.concat("tokens").join("/"));
    await createFolderIfMissing(pathParts.concat("tiles").join("/"));
    await createFolderIfMissing(pathParts.concat("ambient").join("/"));
    await createFolderIfMissing(pathParts.concat("journals").join("/"));
}

async function createFolderIfMissing(folderPath) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    try
    {
        let result = await FilePicker.browse(source, folderPath);
        if ( !result.dir.includes(folderPath) ) await FilePicker.createDirectory(source, folderPath, source === "s3" ? { bucket: game.settings.get("dragupload", "fileUploadBucket") } : {});
    }
    catch (error)
    {
        try {
            await FilePicker.createDirectory(source, folderPath, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
        }
        catch {}
    }
}

async function handlePlaylistDrop(event) {
    event.preventDefault();
    console.log(event);
}

async function handleDrop(event) {
    event.preventDefault();
    console.log(event);

    const files = event.dataTransfer.files;
    console.log(files);

    let file
    if (!files || files.length === 0) {
        let url = event.dataTransfer.getData("Text")
        if (!url) {
            console.log("DragUpload | No Files detected, exiting");
            // Let Foundry handle the event instead
            canvas._onDrop(event);
            return;
        }
        // trimming query string
        if (url.includes("?")) url = url.substr(0, url.indexOf("?"))
        const splitUrl = url.split("/")
        let filename = splitUrl[splitUrl.length - 1]
        if (!filename.includes(".")) {
            console.log("DragUpload | Dragged non-file text:", url);
            // Let Foundry handle the event instead
            canvas._onDrop(event);
            return
        }
        const extension = filename.substr(filename.lastIndexOf(".") + 1)
        const validExtensions =
          Object.keys(CONST.IMAGE_FILE_EXTENSIONS)
          .concat(Object.keys(CONST.VIDEO_FILE_EXTENSIONS))
          .concat(Object.keys(CONST.AUDIO_FILE_EXTENSIONS));
        if (!validExtensions.includes(extension)) {
            console.log("DragUpload | Dragged file with bad extension:", url);
            // Let Foundry handle the event instead
            canvas._onDrop(event);
            return
        }
        // special case: chrome imgur drag from an album gives a low-res webp file instead of a PNG
        if (url.includes("imgur") && filename.endsWith("_d.webp")) {
            filename = filename.substr(0, filename.length - "_d.webp".length) + ".png"
            url = url.substr(0, url.length - "_d.webp".length) + ".png"
        }
        // must be a valid file URL!
        file = {isExternalUrl: true, url: url, name: filename}
    } else {
        file = files[0]
    }

    if (file == undefined) {
        // Let Foundry handle the event instead
        canvas._onDrop(event);
        return;
    }
    console.log(file);

    if (Object.keys(CONST.AUDIO_FILE_EXTENSIONS).filter(x => x != "webm" && file.name.endsWith(x)).length > 0) {
        await HandleAudioFile(event, file);
        return;
    }

    const layer = game.canvas.activeLayer.name;

    if (layer.includes("BackgroundLayer")) {
        await CreateTile(event, file, false);
    }
    else if (layer.includes("ForegroundLayer")) {
        await CreateTile(event, file, true);
    }
    else if (layer.includes("TokenLayer")) {
        await CreateActor(event, file);
    }
    else if (layer.includes("NotesLayer")) {
        await CreateJournalPin(event, file);
    }
    else {
        await CreateTile(event, file);
    }
}

async function HandleAudioFile(event, file) {
    console.log(file.name + " is an audio file");

    await CreateAmbientAudio(event, file);
}

async function CreateAmbientAudio(event, file) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response;
    if (file.isExternalUrl) {
        response = {path: file.url}
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/ambient", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }

    const data = {
        t: "l",
        path: response.path,
        radius: 10,
        easing: true,
        repeat: true,
        volume: 1.0
    };

    convertXYtoCanvas(data, event);

    canvas.sounds.activate();
    await canvas.scene.createEmbeddedDocuments("AmbientSound", [data]);
}

async function CreateTile(event, file, overhead) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response
    if (file.isExternalUrl) {
        response = {path: file.url}
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/tiles", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }
    console.log(response);

    const data = CreateImgData(event, response);

    const tex = await loadTexture(data.img);
    const ratio = canvas.dimensions.size / (data.tileSize || canvas.dimensions.size);
    data.width = tex.baseTexture.width * ratio;
    data.height = tex.baseTexture.height * ratio;
    data.overhead = overhead;

    // Optionally snap to grid
    data.x = data.x - (data.width / 2);
    data.y = data.y - (data.height / 2);
    if ( !event.shiftKey ) foundry.utils.mergeObject(data, canvas.grid.getSnappedPosition(data.x, data.y, 1));

    // Create the tile as hidden if the ALT key is pressed
    if ( event.altKey ) data.hidden = true;

    // Activate Tile layer (if not already active)
    if ( game.release?.generation <= 9 ) {
        if (overhead) {
            canvas.foreground.activate();
        }
        else {
            canvas.background.activate();
        }
    }
    else {
        if ( overhead ) {
            ui.controls.controls.find(c => c.name === "tiles").foreground = true;
        } else {
            ui.controls.controls.find(c => c.name === "tiles").foreground = false;
        }
        canvas.perception.update({refreshLighting: true, refreshTiles: true}, true);
    }
    return canvas.scene.createEmbeddedDocuments('Tile', [data], {});
}

async function CreateJournalPin(event, file) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response
    if (file.isExternalUrl) {
        response = {path: file.url}
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/journals", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }
    console.log(response);

    const data = {
        name: file.name,
        img: response.path
    };

    const journal = await JournalEntry.create(data);
    console.log(journal);

    const pinData = {
        entryId: journal.id,
        icon: "icons/svg/book.svg",
        iconSize: 40,
        text: "",
        fontSize: 48,
        textAnchor: CONST.TEXT_ANCHOR_POINTS.CENTER
    };

    convertXYtoCanvas(pinData, event);

    // Activate Notes layer (if not already active)
    canvas.notes.activate();
    return canvas.scene.createEmbeddedDocuments('Note', [pinData], {});
}

async function CreateActor(event, file) {
    const source = game.settings.get("dragupload", "fileUploadSource");
    let response
    if (file.isExternalUrl) {
        response = {path: file.url}
    } else {
        response = await FilePicker.upload(source, window.dragUpload.targetFolder + "/tokens", file, source === "s3" ? {bucket: game.settings.get("dragupload", "fileUploadBucket")} : {});
    }
    console.log(response);

    const data = CreateImgData(event, response);
    data.name = file.name;
    const tokenData = CreateImgData(event, response);

    if (Object.keys(CONST.IMAGE_FILE_EXTENSIONS).filter(x => file.name.endsWith(x)).length == 0) {
        data.img = "";
    }

    // Ensure the user has permission to drop the actor and create a Token
    if ( !game.user.can("TOKEN_CREATE") ) {
        return ui.notifications.warn(`You do not have permission to create new Tokens!`);
      }

    const types = Object.keys(CONFIG.Actor.sheetClasses);
    types.push("actorless")

      if (types.length > 1) {
        let d = new Dialog({
            title: "What Type should this Actor be created as?",
            buttons: {},
            default: types[0],
            close: () => {}
           });
           console.log(d);

           types.forEach(x => {
            d.data.buttons[x] = {
                label: x,
                callback: async () => await CreateActorWithType(event, data, tokenData, x)
               }
           });

           d.render(true);
      }
      else {
        await CreateActorWithType(event, data, tokenData, types[0]);
      }


}

async function CreateActorWithType(event, data, tokenImageData, type) {
    let createdType = type
    if (type === "actorless") {
        createdType = Object.keys(CONFIG.Actor.sheetClasses)[0]
    }

    let actorName = data.name;
    if (actorName.includes(".")) {
        actorName = actorName.split(".")[0];
    }

    const actor = await Actor.create(
    {
        name: actorName,
        type: createdType,
        img: data.img
    });
    const actorData = foundry.utils.duplicate(actor.data);

    // Prepare Token data specific to this placement
    const td = actor.data.token;
    const hg = canvas.dimensions.size / 2;
    data.x -= (td.width * hg);
    data.y -= (td.height * hg);

    let tokenData;
    if ( game.release?.generation <= 9 ) {
        // Snap the dropped position and validate that it is in-bounds
        tokenData = { x: data.x, y: data.y, hidden: event.altKey, img: tokenImageData.img };
        if ( !event.shiftKey ) foundry.utils.mergeObject(tokenData, canvas.grid.getSnappedPosition(data.x, data.y, 1));
        if ( !canvas.grid.hitArea.contains(tokenData.x, tokenData.y) ) return false;

        // Get the Token image
        if ( actorData.token.randomImg ) {
            let images = await actor.getTokenImages();
            images = images.filter(i => (images.length === 1) || !(i === this._lastWildcard));
            const image = images[Math.floor(Math.random() * images.length)];
            tokenData.img = this._lastWildcard = image;
        }

        // Merge Token data with the default for the Actor
        tokenData = foundry.utils.mergeObject(actorData.token, tokenData, {inplace: true});
        tokenData.actorId = actor.data._id;
        tokenData.actorLink = true;
    }
    else {
        // Snap the dropped position and validate that it is in-bounds
        tokenData = { x: data.x, y: data.y, hidden: event.altKey, img: tokenImageData.img };
        if ( !event.shiftKey ) foundry.utils.mergeObject(tokenData, canvas.grid.getSnappedPosition(data.x, data.y, 1));
        const d = canvas.dimensions;
        tokenData.x = Math.clamped(tokenData.x, 0, d.width-1);
        tokenData.y = Math.clamped(tokenData.y, 0, d.height-1);

        // Get the Token image
        if ( actorData.prototypeToken.randomImg ) {
            let images = await actor.getTokenImages();
            images = images.filter(i => (images.length === 1) || !(i === this._lastWildcard));
            const image = images[Math.floor(Math.random() * images.length)];
            tokenData.img = this._lastWildcard = image;
        }

        // Merge Token data with the default for the Actor
        tokenData = foundry.utils.mergeObject(actorData.prototypeToken, tokenData, {inplace: true});
        tokenData.actorId = actor.data._id;
        tokenData.actorLink = true;
    }

    // Submit the Token creation request and activate the Tokens layer (if not already active)
    canvas.getLayerByEmbeddedName("Token").activate();
    await canvas.scene.createEmbeddedDocuments('Token', [tokenData], {});

    // delete actor if it's actorless
    if (type === "actorless") {
        actor.delete();
    }
}

function CreateImgData(event, response) {
    const data = {
        img: response.path
    };

    convertXYtoCanvas(data, event);

    return data;
}

function convertXYtoCanvas(data, event) {

    // Acquire the cursor position transformed to Canvas coordinates
    const [x, y] = [event.clientX, event.clientY];
    const t = canvas.stage.worldTransform;
    data.x = (x - t.tx) / canvas.stage.scale.x;
    data.y = (y - t.ty) / canvas.stage.scale.y;

    // Allow other modules to overwrite this, such as Isometric
    Hooks.callAll("dragDropPositioning", { event: event, data: data });
    console.log(data);
}
