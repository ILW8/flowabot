const ipc = require('node-ipc');

const fs = require('fs');
const path = require('path');
const os = require('os');
const util = require('util');

const axios = require('axios');
const Jimp = require('jimp');
const crypto = require('crypto');
const ffmpeg = require('ffmpeg-static');

const unzip = require('unzipper');
const disk = require('diskusage');

const EventEmitter = require('events');

const {execFile, fork, spawn} = require('child_process');

const config = require('../config.json');
const helper = require('../helper.js');
const aws = require('aws-sdk');

const MAX_SIZE = 8 * 1024 * 1024;



let frame_counter = 0;




let enabled_mods = [""];
const MAX_EMBED_SIZE = 50 * 1024 * 1024;

const resources = path.resolve(__dirname, "res");


function getTimingPoint(timingPoints, offset) {
	let timingPoint = timingPoints[0];

	for (let x = timingPoints.length - 1; x >= 0; x--) {
		if (timingPoints[x].offset <= offset) {
			timingPoint = timingPoints[x];
			break;
		}
	}

	return timingPoint;
}

async function processHitsounds(beatmap_path) {
	let hitSoundPath = {};

	let setHitSound = (file, base_path, custom) => {
		let hitSoundName = path.basename(file, path.extname(file));

		if (hitSoundName.match(/\d+/) === null && custom)
			hitSoundName += '1';

		let absolutePath = path.resolve(base_path, file);

		if (path.extname(file) === '.wav' || path.extname(file) === '.mp3')
			hitSoundPath[hitSoundName] = absolutePath;
	};

	let defaultFiles = await fs.promises.readdir(path.resolve(resources, 'hitsounds'));

	defaultFiles.forEach(file => setHitSound(file, path.resolve(resources, 'hitsounds')));

	// some beatmaps use custom 1 without having a file for it, set default custom 1 hitsounds
	defaultFiles.forEach(file => setHitSound(file, path.resolve(resources, 'hitsounds'), true));

	// overwrite default hitsounds with beatmap hitsounds
	let beatmapFiles = await fs.promises.readdir(beatmap_path);

	beatmapFiles.forEach(file => setHitSound(file, beatmap_path, true));

	return hitSoundPath;
}

async function renderHitsounds(mediaPromise, beatmap, start_time, actual_length, modded_length, time_scale, file_path) {
	let media = await mediaPromise;

	if (!media)
		throw "Beatmap data not available";

	let execFilePromise = util.promisify(execFile);

	let beatmapAudio = false;

	try {
		// helper.log(start_time)
		await execFilePromise(ffmpeg, [
			'-ss', start_time / 1000, '-i', `"${media.audio_path}"`, '-t', actual_length * Math.max(1, time_scale) / 1000,
			'-filter:a', `"afade=t=out:st=${Math.max(0, actual_length * time_scale / 1000 - 0.5 / time_scale)}:d=0.5,atempo=${time_scale},volume=0.7"`,
			path.resolve(file_path, 'audio.wav')
		], {shell: true});

		beatmapAudio = true;
	} catch (e) {
		console.error(e);
		//throw "Error trimming beatmap audio";
	}

	let hitSoundPaths = await processHitsounds(media.beatmap_path);

	let hitObjects = beatmap.hitObjects.filter(a => a.startTime >= start_time && a.startTime < start_time + actual_length * time_scale);
	let hitSounds = [];

	const scoringFrames = beatmap.ScoringFrames.filter(a => a.offset >= start_time && a.offset < start_time + actual_length);

	if (beatmap.Replay.auto !== true) {
		for (const scoringFrame of scoringFrames) {
			if (scoringFrame.combo >= scoringFrame.previousCombo || scoringFrame.previousCombo < 30)
				continue;

			hitSounds.push({
				offset: (scoringFrame.offset - start_time) / time_scale,
				sound: 'combobreak',
				path: hitSoundPaths['combobreak'],
				volume: 2.5
			});
		}
	}

	for (const hitObject of hitObjects) {
		let timingPoint = getTimingPoint(beatmap.timingPoints, hitObject.startTime);

		if (hitObject.objectName === 'circle' && Array.isArray(hitObject.HitSounds)) {
			let offset = hitObject.startTime;

			if (beatmap.Replay.auto !== true) {
				if (hitObject.hitOffset == null)
					continue;

				offset += hitObject.hitOffset;
			}

			offset -= start_time;
			offset /= time_scale;

			for (const hitSound of hitObject.HitSounds) {

				if (hitSound in hitSoundPaths) {
					hitSounds.push({
						offset,
						sound: hitSound,
						path: hitSoundPaths[hitSound],
						volume: timingPoint.sampleVolume / 100
					});
				}
			}
		}

		if (hitObject.objectName === 'slider') {
			hitObject.EdgeHitSounds.forEach((edgeHitSounds, index) => {
				edgeHitSounds.forEach(hitSound => {
					let offset = hitObject.startTime + index * (hitObject.duration / hitObject.repeatCount);

					if (index === 0 && beatmap.Replay.auto !== true) {
						if (hitObject.hitOffset == null)
							return;

						offset += hitObject.hitOffset;
					}

					let edgeTimingPoint = getTimingPoint(beatmap.timingPoints, offset);

					offset -= start_time;
					offset /= time_scale;

					if (hitSound in hitSoundPaths) {
						hitSounds.push({
							offset,
							sound: hitSound,
							path: hitSoundPaths[hitSound],
							volume: edgeTimingPoint.sampleVolume / 100
						});
					}
				});
			});

			hitObject.SliderTicks.forEach(tick => {
				for (let i = 0; i < hitObject.repeatCount; i++) {
					let offset = hitObject.startTime + (i % 2 === 0 ? tick.offset : tick.reverseOffset) + i * (hitObject.duration / hitObject.repeatCount);

					let tickTimingPoint = getTimingPoint(beatmap.timingPoints, offset);

					offset -= start_time;
					offset /= time_scale;

					tick.HitSounds[i].forEach(hitSound => {
						if (hitSound in hitSoundPaths) {
							hitSounds.push({
								type: 'slidertick',
								offset,
								sound: hitSound,
								path: hitSoundPaths[hitSound],
								volume: tickTimingPoint.sampleVolume / 100
							});
						}
					});
				}
			});
		}
	}

	let ffmpegArgs = [];

	let hitSoundIndexes = {};

	hitSounds.forEach(hitSound => {
		if (!(hitSound.sound in hitSoundIndexes)) {
			ffmpegArgs.push('-guess_layout_max', '0', '-i', hitSound.path);
			hitSoundIndexes[hitSound.sound] = Object.keys(hitSoundIndexes).length;
		}
	});
	// process in chunks
	let chunkLength = 2500;
	let chunkCount = Math.ceil(modded_length / chunkLength);
	let hitSoundPromises = [];

	let mergeHitSoundArgs = [];
	let chunksToMerge = 0;

	for (let i = 0; i < chunkCount; i++) {
		let hitSoundsChunk = hitSounds.filter(a => a.offset >= i * chunkLength && a.offset < (i + 1) * chunkLength);

		if (hitSoundsChunk.length === 0)
			continue;

		chunksToMerge++;

		let ffmpegArgsChunk = ffmpegArgs.slice();

		ffmpegArgsChunk.push('-filter_complex');

		let filterComplex = "";
		let indexStart = Object.keys(hitSoundIndexes).length;

		hitSoundsChunk.forEach((hitSound, i) => {
			let fadeOutStart = actual_length - 500;
			let fadeOut = hitSound.offset >= fadeOutStart ? (1 - (hitSound.offset - (actual_length - 500)) / 500) : 1;

			filterComplex += `[${hitSoundIndexes[hitSound.sound]}]adelay=${hitSound.offset}|${hitSound.offset},volume=${hitSound.volume * 0.7 * fadeOut}[${i + indexStart}];`
		});

		hitSoundsChunk.forEach((hitSound, i) => {
			filterComplex += `[${i + indexStart}]`;
		});

		filterComplex += `amix=inputs=${hitSoundsChunk.length}:dropout_transition=${actual_length},volume=${hitSoundsChunk.length},dynaudnorm`;

		ffmpegArgsChunk.push(`"${filterComplex}"`, '-ac', '2', path.resolve(file_path, `hitsounds${i}.wav`));
		mergeHitSoundArgs.push('-guess_layout_max', '0', '-i', path.resolve(file_path, `hitsounds${i}.wav`));

		hitSoundPromises.push(execFilePromise(ffmpeg, ffmpegArgsChunk, {shell: true}));
	}

	return new Promise((resolve, reject) => {
		if (chunksToMerge < 1) {
			reject();
			return;
		}

		Promise.all(hitSoundPromises).then(async () => {
			mergeHitSoundArgs.push('-filter_complex', `amix=inputs=${chunksToMerge}:dropout_transition=${actual_length},volume=${chunksToMerge},dynaudnorm`, path.resolve(file_path, `hitsounds.wav`));

			await execFilePromise(ffmpeg, mergeHitSoundArgs, {shell: true});

			const mergeArgs = [];
			let mixInputs = beatmapAudio ? 2 : 1;

			if (beatmapAudio)
				mergeArgs.push('-guess_layout_max', '0', '-i', path.resolve(file_path, `audio.wav`));

			mergeArgs.push(
				'-guess_layout_max', '0', '-i', path.resolve(file_path, `hitsounds.wav`),
				'-filter_complex', `amix=inputs=${mixInputs}:duration=first:dropout_transition=${actual_length},volume=2,dynaudnorm`, path.resolve(file_path, 'merged.wav')
			);

			await execFilePromise(ffmpeg, mergeArgs, {shell: true});

			resolve(path.resolve(file_path, 'merged.wav'));
		}).catch(reject);
	});
}

async function downloadMedia(options, beatmap, beatmap_path, size, download_path) {
	if (options.type !== 'mp4' || !options.audio || !config.credentials.osu_api_key)
		return false;

	let output = {};

	let beatmapset_id = beatmap.BeatmapSetID;

	if (beatmapset_id == null) {
		const content = await fs.promises.readFile(beatmap_path, 'utf8');
		const hash = crypto.createHash('md5').update(content).digest("hex");

		const {data} = await axios.get('https://osu.ppy.sh/api/get_beatmaps', {
			params: {
				k: config.credentials.osu_api_key,
				h: hash
			}
		});

		if (data.length === 0) {
			throw "Couldn't find beatmap";
		}

		beatmapset_id = data[0].beatmapset_id;
	}

	let mapStream;

	try {
		const chimuCheckMapExists = await axios.get(`https://api.chimu.moe/v1/set/${beatmapset_id}`, {timeout: 2000});

		if (chimuCheckMapExists.status !== 200){
			// noinspection ExceptionCaughtLocallyJS
				throw "Map not found";
			}

		const chimuMap = await axios.get(`https://api.chimu.moe/v1/download/${beatmapset_id}?n=0`, {
			timeout: 10000,
			responseType: 'stream'
		});

		mapStream = chimuMap.data;
	} catch (e) {
		const beatconnectMap = await axios.get(`https://beatconnect.io/b/${beatmapset_id}`, {responseType: 'stream'});
		mapStream = beatconnectMap.data;
	}

	const extraction_path = path.resolve(download_path, 'map');

	const extraction = mapStream.pipe(unzip.Extract({path: extraction_path}));

	await new Promise((resolve, reject) => {
		extraction.on('close', resolve);
		extraction.on('error', reject);
	});

	output.beatmap_path = extraction_path;

	if (beatmap.AudioFilename && await helper.fileExists(path.resolve(extraction_path, beatmap.AudioFilename)))
		output.audio_path = path.resolve(extraction_path, beatmap.AudioFilename);

	if (beatmap.bgFilename
		&& await helper.fileExists(path.resolve(extraction_path, beatmap.bgFilename))
		&& !options.nobg) {
		output.background_path = path.resolve(extraction_path, beatmap.bgFilename);
	}

	if (beatmap.bgFilename && output.background_path) {
		try {
			const img = await Jimp.read(output.background_path);

			let bg_shade = 80;
			if (options.bg_opacity) {
				bg_shade = 100 - options.bg_opacity;
			}

			await img
				.cover(...size)
				.color([
					{apply: 'shade', params: [bg_shade]}
				])
				.writeAsync(path.resolve(extraction_path, 'bg.png'));
			output.background_path = path.resolve(extraction_path, 'bg.png');
		} catch (e) {
			output.background_path = null;
			helper.error(e);
		}
	} else if (Object.keys(output).length === 0) {
		return false;
	}

	return output;
}


let s3 = null;
let beatmap, speed_multiplier;
let has_aborted = false;

function check_abort(render_id){
	let renders = JSON.parse(helper.getItem("render_queue"));
	// return renders === null ? false : (renders.hasOwnProperty(render_id) ? renders[render_id].abort : false);
	if (renders === null){
		return false;
	}
	if (renders.hasOwnProperty(render_id)){
		return renders[render_id].abort;
	}
	return false;
}

module.exports = {
	get_frame: function (beatmap_path, time, enabled_mods, size, options, cb) {
		let worker = fork(path.resolve(__dirname, 'beatmap_preprocessor.js'), ['--max-old-space-size=512']);

		worker.send({
			beatmap_path,
			options,
			enabled_mods
		});

		worker.on('close', code => {
			if (code > 0) {
				cb("Error processing beatmap");
				return false;
			}
		});

		worker.on('message', _beatmap => {
			beatmap = _beatmap;

			if (time === 0 && options.percent) {
				time = beatmap.hitObjects[Math.floor(options.percent * beatmap.hitObjects.length)].startTime - 2000;
			} else {
				let firstNonSpinner = beatmap.hitObjects.filter(x => x.objectName !== 'spinner');
				time = Math.max(time, firstNonSpinner[0].startTime);
			}

			let worker = fork(path.resolve(__dirname, 'render_worker.js'));

			worker.on('close', code => {
				if (code > 0) {
					cb("Error rendering beatmap");
					return false;
				}
			});

			worker.on('message', buffer => {
				cb(null, Buffer.from(buffer, 'base64'));
			});

			worker.send({
				beatmap,
				start_time: time,
				options,
				size
			});
		});
	},

	get_frames: async function (beatmap_path, time, length, enabled_mods, size, options, cb) {



		if (config.debug)
			console.time('process beatmap');

		class Queue extends EventEmitter {
			constructor(){
				super();
				this.frames = [];
				this.emitEvents = false;
				this.throttleThreshold = 3;
			}

			enableEvents(){this.emitEvents = true;}
			disableEvents(){this.emitEvents = false;}

			enqueue(frame){
				this.frames.push(frame);
			}
			dequeue() {
				if (this.frames.length - 1 < this.throttleThreshold && this.emitEvents){
					this.emit('unthrottle');
				}
				return this.frames.shift();
			}
			isEmpty() { return this.frames.length === 0; }
			length() { return this.frames.length; }
			peek() { return !this.isEmpty() ? this.frames[0] : undefined; }
			shouldSlowdown() { return this.length() > 1};
		}


		const {msg, render} = options;

		options.msg = null;

		const renderStatus = ['– processing beatmap', '– rendering video', `[render ID ${render.id}]`];

		// noinspection JSCheckFunctionSignatures
		const renderMessage = await msg.channel.send({embed: {description: renderStatus.join("\n")}});

		const updateRenderStatus = async () => {
			await renderMessage.edit({
				embed: {
					description: renderStatus.join("\n")
				}
			});
		};

		const updateInterval = setInterval(() => {
			updateRenderStatus().catch(console.error)
		}, 3000);

		updateRenderStatus().catch(console.error);

		const resolveRender = async opts => {
			updateRenderStatus();
			clearInterval(updateInterval);

			if(options.toS3 && typeof opts === "object"){  //if opts not an object, send error msg to discord directly
				if (config.credentials.S3.client_id !== "" &&
					config.credentials.S3.client_secret !== "" &&
					config.credentials.S3.bucket_name !== "" &&
					config.credentials.S3.bucket_endpoint !== ""){
					const doSpacesEndpoint = new aws.Endpoint(config.credentials.S3.bucket_endpoint);
					s3 = new aws.S3({
						endpoint: doSpacesEndpoint,
						accessKeyId: config.credentials.S3.client_id,
						secretAccessKey: config.credentials.S3.client_secret
					});
				}

				if (s3 !== null){
					// await msg.channel.send("yep uploading to s3 ty");

					let readStream = fs.createReadStream(opts.files[0].attachment);
					readStream.on('error', function(err){
						msg.channel.send(err);
					})
					readStream.on('open', function() {
						let upload_params = {
							Bucket: config.credentials.S3.bucket_name,
							Key: `${crypto.randomBytes(16).toString('hex')}.${opts.files[0].name}`,
							Body: readStream,
							ACL: "public-read"
						}
						s3.upload(upload_params, function(err, data) {
							if (err) {console.log(err, err.stack);}
							else     {
								// console.log(data);
								// msg.channel.send(`https://${data.Location}`);
								if (data.Location.includes("https://")) {
									msg.channel.send(data.Location);
								}else{
									msg.channel.send(`https://${data.Location}`);
								}
								renderMessage.delete();
							}
						});
					})
				}
			} else {
				await msg.channel.send(opts);
				await renderMessage.delete();
			}

		};

		const beatmapProcessStart = Date.now();

		let worker = fork(path.resolve(__dirname, 'beatmap_preprocessor.js'));

		let frames_rendered = [], frames_piped = [], current_frame = 0;

		worker.send({
			beatmap_path,
			options,
			enabled_mods,
			speed_override: options.speed
		});

		worker.on('close', code => {
			if (code > 0) {
				resolveRender("Error processing beatmap").catch(console.error);

				return false;
			}

			renderStatus[0] = `✓ processing beatmap (${((Date.now() - beatmapProcessStart) / 1000).toFixed(3)}s)`;
		});



		let worker_frame_queues = {};
		let worker_frame_buffers = {};



		worker.on('message', async _beatmap => {
			beatmap = _beatmap;
			beatmap.hitObjects = _beatmap.hitObjects;  // to make IDE shut up about unknown reference

			if (config.debug)
				console.timeEnd('process beatmap');

			{
				if (time === 0 && options.percent) {
					time = beatmap.hitObjects[Math.floor(options.percent * (beatmap.hitObjects.length - 1))].startTime - 2000;
					if (options.offset) {
						time += options.offset
					}
				} else if (options.objects) {
					let objectIndex = 0;

					for (let i = 0; i < beatmap.hitObjects.length; i++) {
						if (beatmap.hitObjects[i].startTime >= time) {
							objectIndex = i;
							break;
						}
					}

					if (options.offset) {
						time += options.offset
						helper.log(options.offset)
					}
					time -= 200;

					if (beatmap.hitObjects.length > objectIndex + options.objects)
						length = beatmap.hitObjects[objectIndex + options.objects].startTime - time + 400;

					if (length >= 10 * 1000)
						options.type = 'mp4';

				} else {
					let firstNonSpinner = beatmap.hitObjects.filter(x => x.objectName !== 'spinner');
					time = Math.max(time, Math.max(0, firstNonSpinner[0].startTime - 1000));
					if (options.offset) {
						time += options.offset
						helper.log(options.offset)
					}
				}
			}

			if (options.combo) {
				let current_combo = 0;

				for (let hitObject of beatmap.hitObjects) {
					if (hitObject.objectName === 'slider') {
						current_combo += 1;

						for (let i = 0; i < hitObject.repeatCount; i++) {
							current_combo += 1 + hitObject.SliderTicks.length;
							time = hitObject.startTime + i * (hitObject.duration / hitObject.repeatCount);

							if (current_combo >= options.combo)
								break;
						}

						if (current_combo >= options.combo)
							break;
					} else {
						current_combo += 1;
						time = hitObject.endTime;

						if (current_combo >= options.combo)
							break;
					}
				}
			}

			let lastObject = beatmap.hitObjects[beatmap.hitObjects.length - 1];
			let lastObjectTime = lastObject.endTime + 1500;

			length = Math.min(900 * 1000, length);
			let start_time = time;
			let time_max = Math.min(time + length + 1000, lastObjectTime);
			let actual_length = time_max - time;

			let rnd = Math.round(1e9 * Math.random());
			let file_path;
			let fps = options.fps || 60;

			let time_scale = 1;

			if (enabled_mods.includes('DT') || enabled_mods.includes('NC'))
				time_scale *= 1.5;

			if (enabled_mods.includes('HT') || enabled_mods.includes('DC'))
				time_scale *= 0.75;

			if (options.speed !== 1)
				time_scale = options.speed;

			actual_length = Math.min(length + 1000, Math.max(actual_length, actual_length / time_scale));

			if (!('type' in options)) {
				options.type = 'gif';
			}
			if (options.type === 'gif') {
				fps = 50;
			}

			let time_frame = 1000 / fps * time_scale;
			let bitrate = 2 * 1024;


			file_path = path.resolve(config.frame_path != null ? config.frame_path : os.tmpdir(), 'frames', `${rnd}`);
			await fs.promises.mkdir(file_path, {recursive: true});

			let threads = require('os').cpus().length;
			let modded_length = time_scale > 1 ? Math.min(actual_length * time_scale, lastObjectTime) : actual_length;
			let amount_frames = Math.floor(modded_length / time_frame);


			// recursively does reads frame from file and pipes to 2nd ffmpeg stdin
			let pipeFrameLoop = (ffmpegProcess, cb) => {
				if (frames_rendered.includes(current_frame)) {
					let frame_path = path.resolve(file_path, `${current_frame}.rgba`);
					fs.promises.readFile(frame_path).then(buf => {
						ffmpegProcess.stdin.write(buf, err => {
							if (err) {
								cb(null);
								return;
							}

							fs.promises.rm(frame_path, {recursive: true}).catch(helper.error);

							frames_piped.push(current_frame);
							frames_rendered.slice(frames_rendered.indexOf(current_frame), 1);

							if (frames_piped.length === amount_frames) {
								ffmpegProcess.stdin.end();
								cb(null);
								return;
							}

							current_frame++;
							pipeFrameLoop(ffmpegProcess, cb);
						});
					}).catch(err => {
						resolveRender("Error encoding video").catch(console.error);
						helper.error(err);
					});
				} else {
					setTimeout(() => {
						pipeFrameLoop(ffmpegProcess, cb);
					}, 50);
				}
			}

			let newPipeFrameLoop = async (ffmpegProcess, callback) => {
				// helper.log("################### entering newPipeFrameLoop #######################");
				let next_frame_worker_id = 0;
				let frame_counter = 0;
				while (frame_counter < amount_frames) {
					let next_frame_worker_queue = worker_frame_queues[next_frame_worker_id];
					let next_frame = next_frame_worker_queue.peek();
					if (typeof next_frame === 'undefined') {
						// helper.log("queue empty... sleeping (waiting on " + next_frame_worker_id + " - video frame #" + frame_counter +")");
						// helper.log("waiting on next frame, sleeping...");
						await new Promise(r => setTimeout(r, 20));
						continue;
					}

					// let next_frame_buffer = Buffer.from(next_frame);
					// helper.log(next_frame_buffer.length);
					ffmpegProcess.stdin.write(next_frame, err => {
						if (err) {
							helper.error("something bad happened on video encoder");
							helper.error(err);
							callback(null);
						}
					});

					frame_counter++;

					if (frame_counter === amount_frames){
						ffmpegProcess.stdin.end();
						callback(null);
						return;
					}

					next_frame_worker_id = (next_frame_worker_id + 1) % threads;
					next_frame_worker_queue.dequeue();
					// helper.log("end of loop: " + next_frame_worker_id, worker_frame_queues);

					// await new Promise(r => setTimeout(r, 5));
				}

			}


			let ffmpeg_args = ['-f', 'rawvideo', '-r', fps, '-s', size.join('x'), '-pix_fmt', 'rgba',
				'-c:v', 'rawvideo', '-thread_queue_size', 1024,
				'-i', 'pipe:0'];

			let mediaPromise = downloadMedia(options, beatmap, beatmap_path, size, file_path);
			let audioProcessingPromise = renderHitsounds(mediaPromise, beatmap, start_time, actual_length, modded_length, time_scale, file_path);

			if (options.type === 'mp4'){
				if (options.toS3){
                		bitrate = Math.min(bitrate, (0.7 * MAX_EMBED_SIZE) * 8 / (actual_length / 1000) / 1024);
					} else {
						bitrate = Math.min(bitrate, (0.7 * MAX_SIZE) * 8 / (actual_length / 1000) / 1024);
					}
				}

			let done = 0;

			if (config.debug)
				console.time('render beatmap');

			if (options.type === 'gif') {
				if (config.debug)
					console.time('encode video');

				ffmpeg_args.push(`${file_path}/video.gif`);

				const encodingProcessStart = Date.now();

				let ffmpegProcess = spawn(ffmpeg, ffmpeg_args, {shell: true});

				ffmpegProcess.on('close', async code => {
					if (code > 0) {
						resolveRender("Error encoding video")
							.then(() => {
								fs.promises.rm(file_path, {recursive: true}).catch(helper.error);
							}).catch(console.error);

						return false;
					}

					if (config.debug)
						console.timeEnd('encode video');

					// renderStatus[1] = `✓ encoding video (${((Date.now() - encodingProcessStart) / 1000).toFixed(3)}s)`;

					resolveRender({
						files: [{
							attachment: `${file_path}/video.${options.type}`,
							name: `video.${options.type}`
						}]
					}).then(() => {
						fs.promises.rm(file_path, {recursive: true}).catch(helper.error);
					}).catch(console.error);
				});

				pipeFrameLoop(ffmpegProcess, err => {
					if (err) {
						resolveRender("Error encoding video")
							.then(() => {
								fs.promises.rm(file_path, {recursive: true}).catch(helper.error);
							}).catch(console.error);

						return false;
					}
				});
			} else {
				Promise.all([mediaPromise, audioProcessingPromise]).then(response => {
					let media = response[0];
					let audio = response[1];

					if (media.background_path)
						ffmpeg_args.unshift('-loop', '1', '-r', fps, '-i', `"${media.background_path}"`);
					else
						ffmpeg_args.unshift('-f', 'lavfi', '-r', fps, '-i', `color=c=black:s=${size.join("x")}`);

					ffmpeg_args.push('-i', audio);

					bitrate -= 96;
				}).catch(e => {
					helper.error(e);
					ffmpeg_args.unshift('-f', 'lavfi', '-r', fps, '-i', `color=c=black:s=${size.join("x")}`);
					helper.log("rendering without audio");
				}).finally(() => {
					if (config.debug)
						console.time('encode video');

					ffmpeg_args.push(
						'-filter_complex', `"overlay=(W-w)/2:shortest=1"`,
						'-pix_fmt', 'yuv420p', '-r', fps, '-c:v', 'libx264', '-b:v', `${bitrate}k`,
						'-c:a', 'aac', '-b:a', '96k', '-shortest', '-preset', 'veryfast',
						'-movflags', 'faststart', '-g', fps, '-force_key_frames', '00:00:00.000', `${file_path}/video.mp4`
					);

					const encodingProcessStart = Date.now();

					let ffmpegProcess = spawn(ffmpeg, ffmpeg_args, {shell: true});

					ffmpegProcess.on('close', code => {
						if (code > 0) {
							resolveRender("Error encoding video")
								.then(() => {
									fs.promises.rm(file_path, {recursive: true}).catch(helper.error);
								}).catch(console.error);

							return false;
						}

						if (config.debug)
							console.timeEnd('encode video');

						renderStatus[1] = `✓ rendering video (${((Date.now() - encodingProcessStart) / 1000).toFixed(3)}s)`;

						resolveRender({
							files: [{
								attachment: `${file_path}/video.${options.type}`,
								name: `video.${options.type}`
							}]
						}).then(() => {
							fs.promises.rm(file_path, {recursive: true}).catch(helper.error);
						}).catch(console.error);
					});

					ffmpegProcess.stderr.on('data', data => {
						const line = data.toString();

						if (!line.startsWith('frame='))
							return;

						// helper.log(line);
						const frame = parseInt(line.substring(6).trim());

						renderStatus[1] = `– rendering video (${Math.round(frame / amount_frames * 100)}%)`;
					});

					newPipeFrameLoop(ffmpegProcess, err => {
						if (err) {
							resolveRender("Error encoding video");

							return false;
						}
					}).then(() => { helper.log("newPipeFrameLoop done") })

					// pipeFrameLoop(ffmpegProcess, err => {
					// 	if (err) {
					// 		resolveRender("Error encoding video")
					// 			.then(() => {
					// 				fs.promises.rm(file_path, {recursive: true}).catch(helper.error);
					// 			}).catch(console.error);
					//
					// 		return false;
					// 	}
					// });
				});
			}

			const framesProcessStart = Date.now();
			helper.log("Expected number of frames: " + amount_frames);


			let workers = [];
			for (let i = 0; i < threads; i++) {
				workers.push(
					fork(path.resolve(__dirname, 'render_worker.js'))
				);
			}


			let log_as_server = function(message) {
				helper.log("[main thread] " + message);
			}

			ipc.config.id = 'world';
			ipc.config.retry= 25;
			// ipc.config.rawBuffer=true;
			// ipc.config.encoding ='base64';
			ipc.config.logger = log_as_server
			ipc.config.silent = true;

			let worker_idx = 0;

			ipc.serve(
				function(){
					ipc.server.on(
						'connect',
						function(socket){
							ipc.log("Client connected");
						}
					);

					ipc.server.on(
						'workerReady',
						function(data,socket){
							log_as_server('Worker ready: ' + data);
							ipc.server.emit(socket, 'setWorker', worker_idx);

							let worker_to_init = workers[worker_idx];
							worker_frame_queues[worker_idx] = new Queue();
							worker_frame_queues[worker_idx].enableEvents();
							worker_frame_queues[worker_idx].on('unthrottle', function(){
								ipc.server.emit(socket, 'app.resumeWorking', 'true');
							});

							worker_frame_buffers[worker_idx] = [];  // init frame buffer

							ipc.server.emit(socket, 'receiveWork', {
								beatmap,
								start_time: time + worker_idx * time_frame,
								end_time: time + worker_idx * time_frame + modded_length,
								time_frame: time_frame * threads,
								file_path,
								options,
								threads,
								current_frame: worker_idx,
								size
							});

							let abort_interval = setInterval(() => {
								if (check_abort(render.id)){
									has_aborted = true;
									ipc.server.emit(socket, 'abort', '');
								}
							}, 500);


							worker_to_init.on('close', code => {
								clearInterval(abort_interval);
								done++;

								if (done === threads) {
									// renderStatus[1] = `✓ rendering frames (${((Date.now() - framesProcessStart) / 1000).toFixed(3)}s)`;

									let renders = JSON.parse(helper.getItem("render_queue"));
									delete renders[render.id];
									helper.setItem("render_queue", JSON.stringify(renders));


									if (config.debug)
										console.timeEnd('render beatmap');

									if (has_aborted){
										resolveRender(`Aborted render ${render.id}.`);
									}

									ipc.server.stop();
								}

								if (code > 0) {
									cb("Error rendering beatmap");
									return false;
								}
							});

							worker_idx++;
						}
					);

					ipc.server.on(
						'app.framedata',
						function(data, socket){


							// todo: implement slowing down of frame tap if video encoder can't keep up
							let frame_wid = data.worker_id;
							worker_frame_buffers[frame_wid].push(Buffer.from(data.frame_data, 'base64'));
							ipc.server.emit(socket, 'app.framedataAck', 'ACK');
							if(data.last){
								// log_as_server("received full frame from worker " + frame_wid + ", received in total: " + ++frame_counter + ", video frame #" + data.video_frame_seqno);
								worker_frame_queues[frame_wid].enqueue(Buffer.concat(worker_frame_buffers[frame_wid]))
								worker_frame_buffers[frame_wid].splice(0, worker_frame_buffers[frame_wid].length);
								if(worker_frame_queues[frame_wid].length() < worker_frame_queues[frame_wid].throttleThreshold){
									ipc.server.emit(socket, 'app.resumeWorking', 'true');
								}
							}
					})

					ipc.server.on(
						'app.readyToTerminate',
						function(data, socket){
							ipc.server.emit(socket, 'app.terminate', '');
						})
				}
			);

			ipc.server.start();



		});
	}
};
