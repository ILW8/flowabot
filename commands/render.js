const URL = require('url');
const path = require('path');
const os = require('os');
const process = require('process');

const osu = require('../osu.js');
const helper = require('../helper.js');
const frame = require('../renderer/render_frame.js')
const config = require('../config.json');

function abort_handler(msg, render_args, reject){
	if (render_args.length !== 2) {
		reject(`Expected exactly 2 arguments for a render abort, got ${render_args.length} arguments.`);
		return;
	}
	let render_id = render_args.indexOf('abort') ? render_args[0] : render_args[1];
	try{
		render_id = parseInt(render_id);
		render_id = render_id.toString();  // this is dumb, fix please
		console.log(`Aborting render ${render_id}`);
		console.log(helper.getItem("render_queue"));
		if (JSON.parse(helper.getItem("render_queue")).hasOwnProperty(render_id)){
			console.log(`${render_id} exists`);
			let render = JSON.parse(helper.getItem("render_queue"))[render_id];
			render.abort = true;
			update_render(render);
			return;
		}
		reject(`Render '${render_id}' not found.`);
	} catch (e) {
		reject(`Could not abort render '${render_id}': ${e}`);
	}

}

function queue_render(){
	let renders = JSON.parse(helper.getItem("render_queue"));
	if (renders === null) {
		renders = {};
	}
	let render_id;
	while (true){
		render_id = process.pid * 1000 + Math.floor(Math.random() * 1000);
		render_id = render_id.toString();
		if (!renders.hasOwnProperty(render_id)){
			break;
		}
	}
	renders[render_id] = {
		"id": render_id,
		"status": "queued",
		"start_time": Date.now(),
		"abort": false
	};
	helper.setItem("render_queue", JSON.stringify(renders));
	return renders[render_id];
}

function update_render(render){
	let renders = JSON.parse(helper.getItem("render_queue"));
	renders[render.id] = render;
	helper.setItem("render_queue", JSON.stringify(renders));
}

module.exports = {
    command: ['render', 'frame', 'fail'],
    description: "Render picture or gif of a beatmap at a specific time. Videos 10 seconds or longer are automatically rendered as mp4 video with audio and beatmap background.",
    usage: '[beatmap url] [+mods] [AR8] [CS6] [preview/strains/aim/speed/fail] [HD] [20%] [mp4] [plain] [120fps] [mm:ss] [353x] [4s] [highres]',
    example: [
        {
            run: "render strains",
            result: "Returns a gif of the hardest part on the last beatmap."
        },
        {
            run: "fail",
            result: "Returns a gif of the part where the player failed on the last beatmap."
        },
        {
            run: "render 1:05",
            result: "Returns an image of the last beatmap at 1 minute and 5 seconds."
        },
        {
            run: "render speed 10s 50%",
            result: "Returns a 10 second video of the streamiest part on the last beatmap at half speed."
        },
        {
            run: "render 120fps 353x plain",
            result: "Returns a 120fps video at 353 combo on the last beatmap without sound and black background."
        }
    ],
    configRequired: ['debug'],
    call: obj => {
        return new Promise((resolve, reject) => {
            let { argv, msg, last_beatmap } = obj;

            let beatmap_id, beatmap_url, beatmap_promise, mods = [], time = 0,
            ar, cs, od, length = 0, percent = 0, custom_url = false, nobg = false, bg_opacity = 20,
            size = [400, 300], type, objects,
            video_type = 'gif', audio = true, download_promise, osr, offset;

            let score_id;

            if(argv[0].toLowerCase() === 'fail'){
                if(msg.channel.id in last_beatmap){
                    if(last_beatmap[msg.channel.id].rank !== 'F'){
                        reject("Last play is not a failed score");
                        return false;
                    }

                    percent = last_beatmap[msg.channel.id].fail_percent;
                    length = 4;
                }
            }

            let fps = 60;
            let combo = 0;
            let speed = 1;
            let hidden = false;
            let flashlight = false;
            let analyze = false;
            let toS3 = false;

            argv.map(arg => arg.toLowerCase());

            console.log(argv);
            if (argv.includes('abort')){
				abort_handler(msg, argv.slice(1), reject);
				console.log('aborting');
				return;
			}

            argv.slice(1).forEach(arg => {
                if(arg.startsWith('+'))
                    mods = arg.substr(1).toUpperCase().match(/.{1,2}/g);
                else if(/^([0-9]+):([0-9]+):([0-9]+)$/g.test(arg)){
                    let parts = arg.split(':');
                    if(parts.length > 2){
                        time += parseInt(parts[2]);
                        time += parseInt(parts[1]) * 1000;
                        time += parseInt(parts[0]) * 1000 * 60;
                    }
                }else if(/^([0-9]+):([0-9]+)$/g.test(arg)){
                    let parts = arg.split(':');
                    if(parts.length > 1){
                        time += parseInt(parts[1]) * 1000;
                        time += parseInt(parts[0]) * 1000 * 60;
                    }
                }else if(arg.endsWith('.osr')){
                    osr = arg;
                }else if(arg === 'strains' || arg === 'aim' || arg === 'speed'){
                    type = arg;
                    length = 4;
				}else if(arg === 'preview'){
                    type = arg
                    length = 9;
                    video_type = 'mp4';
                    audio = true;
                }else if(arg === 'hd' || arg === 'hidden'){
                    hidden = true;
                }else if(arg === 'fl' || arg === 'flashlight'){
                    flashlight = true;
                }else if(arg === 'mp4'){
                    video_type = 'mp4';
                }else if(arg === 'audio'){
                    audio = true;
                    video_type = 'mp4';
                }else if(arg === 'plain'){
                    audio = false;
                }else if(arg.endsWith('%')){
                    speed = parseInt(arg) / 100;
                    speed = Math.max(0.01, speed);
                }else if(arg.endsWith('fps')){
                    let _fps = parseInt(arg);
                    if(!isNaN(_fps)){
                        fps = Math.max(1, Math.min(240, _fps));
                        video_type = 'mp4';
                    }
                }else if(arg === 'analyze'){
                    analyze = true;
                // }else if(arg.endsWith('s')){
                }else if(/^[0-9]+(\.[0-9]+)?s$/g.test(arg)){
                    length = parseFloat(arg);
                }else if(arg.endsWith('x')){
                    combo = parseInt(arg);
                }else if(/^([0-9]+)$/g.test(arg)){
                    time += parseInt(arg) * 1000;
                }else if(arg.toLowerCase().startsWith('ar')){
                    ar = parseFloat(arg.substr(2));
                }else if(arg.toLowerCase().startsWith('cs')){
                    cs = parseFloat(arg.substr(2));
                }else if(arg.toLowerCase().startsWith('od')) {
					od = parseFloat(arg.substr(2));
				}else if(arg.toLowerCase().endsWith('offset')){
                	offset = parseInt(arg) * 1000;
				}else if(arg.startsWith('(') && arg.endsWith(')')){
                    objects = arg.substr(1, arg.length - 1).split(',').length;
                }else if(arg === 'fail'){
                    if(msg.channel.id in last_beatmap){
                        if(last_beatmap[msg.channel.id].fail_percent === 1){
                            reject("Last play is not a failed score");
                            return false;
                        }

                        percent = last_beatmap[msg.channel.id].fail_percent;
                        length = 4;
                    }
                } else if(arg === 'nobg') {
					nobg = true;
				} else if(arg.toLowerCase().endsWith('bgo')){
					bg_opacity = parseInt(arg);
				}else if(arg === 'toS3'){
					toS3 = true;
				}else if(arg === 'highres'){
                	size = [1280, 960];
				}else{
                    // noinspection HttpUrlsUsage
					if(arg.startsWith('http://') || arg.startsWith('https://')){
                        beatmap_url = arg;
                        beatmap_promise = osu.parse_beatmap_url(beatmap_url);
                        beatmap_promise.then(response => {
                            beatmap_id = response;
                            if(!beatmap_id) custom_url = true;
                        });

                    }
                }
            });

            Promise.resolve(beatmap_promise).then(() => {
                if(!(msg.channel.id in last_beatmap)){
                    reject(helper.commandHelp('render'));
                    return false;
                }else if(!beatmap_id && !custom_url){
                    let _last_beatmap = last_beatmap[msg.channel.id];

                    beatmap_id = _last_beatmap.beatmap_id;
                    download_promise = helper.downloadBeatmap(beatmap_id).catch(helper.error);

                    if(last_beatmap[msg.channel.id].score_id && mods.length === 0)
                        ({ score_id } = last_beatmap[msg.channel.id]);

                    if(mods.length === 0)
                        mods = last_beatmap[msg.channel.id].mods;
                }

                let download_path = path.resolve(config.osu_cache_path, `${beatmap_id}.osu`);

                if(config.debug)
                    helper.log('render length', length);

                if(length >= 10)
                    video_type = 'mp4';

                if(config.debug)
                    helper.log('specified ar', ar);

				// noinspection DuplicatedCode,JSDeprecatedSymbols
				if(!beatmap_id || custom_url){
                    let download_url = URL.parse(beatmap_url);
                    download_path = path.resolve(os.tmpdir(), `${Math.floor(Math.random() * 1000000) + 1}.osu`);

                    download_promise = helper.downloadFile(download_path, download_url);
                    download_promise.catch(reject);
                }

                let preview_promise;

                Promise.resolve(download_promise).then(async () => {
                    if(type === 'strains' || type === 'aim' || type === 'speed'){
                        if(config.debug)
                            helper.log('getting strains for mods', mods);

                        time = (await osu.get_strains(download_path, mods.join(''), type)).max_strain_time_real - 2000;
                    }else if(type === 'preview'){
						preview_promise = osu.get_preview_point(download_path);
					}

					Promise.resolve(preview_promise).then(previewTime => {
						let current_render = queue_render();
						if(previewTime)
							time = previewTime;

						if(length > 0 || objects){
							current_render.status = "rendering";
							update_render(current_render);
                            resolve(null);

                            frame.get_frames(download_path, time, length * 1000, mods, size, {
                                combo,
								type: video_type,
								cs,
								ar,
								od,
								analyze,
								hidden,
								flashlight,
								black: false,
								osr,
								score_id,
								audio,
								fps,
								speed,
                                fill: video_type === 'mp4',
								noshadow: true,
								percent,
								offset,
								nobg,
								bg_opacity,
								border: false,
								objects,
								msg,
								render: current_render,
								toS3: toS3,
                            });
						}else{
							frame.get_frame(download_path, time, mods, [800, 600], {
                                combo,
								cs: cs,
								ar: ar,
								score_id,
								black: true,
								fill: true,
								analyze,
								hidden,
								percent: percent,
							}, (err, buf) => {
								if(err)
									reject(err);

								resolve({files: [{ attachment: buf, name: 'frame.png' }]});
							});
						}

					}).catch(err => {
						if(config.debug)
							helper.error(err);

						reject(err);
					});
                }).catch(err => {
                    if(config.debug)
                        helper.error(err);

                    reject(err);
                });
            }).catch(err => {
                if(config.debug)
                    helper.error(err);

                reject(err);
            });
        });
    }
};
