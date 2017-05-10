const fs = require('fs');
const q = require('q');
const exec = require("child_process").exec
const shuffle = require('shuffle-array');
const moment = require('moment');
var AWS = require('aws-sdk');
AWS.config.loadFromPath('./config.json');
var rekognition = new AWS.Rekognition({apiVersion: '2016-06-27'});
var Twitter = require('twitter');

const MIN_HOUR = 7;
const MAX_HOUR = 21;
const SLEEP_TIME = 60 * 1000;
const SLEEP_TIME_AFTER_SEAL = 10 * 60 * 1000;
const IMAGENAME = 'norppa.png';
const STREAM = 'https://ams3-automatic-a04si.pukkistream.net:1936/abr/norppalive/live/norppalive_720p/chunks.m3u8';
const DETECTABLE = [
	'Seal',
	'Mammal',
];
const DETECT_CONFIDENCE = 50;

var sealSeen = false;
var messages = require('./messages.json');
var currentMessage = 0;
shuffle(messages);

var client = new Twitter(require('./twitter_config.json'));

/**
 * Wrapper for console.log with timestamp
 * @param  string msg
 * @return void
 */
function log(msg) {
	var time = moment().format('M.D.YYYY, H:mm:ss');
	console.log('[%s] %s', time, msg);
}

function detectSeals() {
	var params = {
		Image: {
			Bytes: fs.readFileSync(IMAGENAME),
		},
		MinConfidence: DETECT_CONFIDENCE,
	};

	q.ninvoke(rekognition, 'detectLabels', params)
	.then(function(data) {
		for (var i in data.Labels) {
			var label = data.Labels[i];
			if (DETECTABLE.indexOf(label.Name) !== -1) {
				log(label.Name + ' detected with confidence: ' + label.Confidence);
				if (!sealSeen) {
					sealSeen = true;
					return tweetNorppaIsLive(label.Confidence);
				}

				return sleepForAWhile();
			}
		}

		log('No seals detected');
		sealSeen = false;
		return sleepForAWhile();
	})
	.catch(console.log.bind(console));
}

function getStreamScreenshot() {
	var hour = parseInt(moment().format('H'), 10);
	if (hour < MIN_HOUR || hour > MAX_HOUR) {
		sealSeen = false;
		return sleepForAWhile();
	}

	if (fs.existsSync(IMAGENAME)) {
		fs.unlinkSync(IMAGENAME);
	}
	return q.nfcall(exec, 'ffmpeg -i "' + STREAM + '" -f image2  -vframes 1 ' + IMAGENAME)
	.then(detectSeals);
}

function tweetNorppaIsLive(confidence) {
	confidence = Math.round(confidence * 10) / 10;
	var message = messages[currentMessage] + '(Varmuus: ' + confidence + '%)';

	// Read the file reacted by ffmpeg
	q.nfcall(fs.readFile, IMAGENAME)
	// Upload the file as new media
	.then(function(data) {
		return client.post('media/upload', {media: data})
	})
	// Tweet with the media
	.then(function(media) {
		return client.post('statuses/update', {status: message, media_ids: media.media_id_string})
	})
	.then(function () {
		currentMessage++;
		log('Tweeted:', message);
	})
	.then(function() {
		sleepForAWhile();
	});
}

function sleepForAWhile() {
	var defer = q.defer();
	if (sealSeen) {
		setTimeout(defer.resolve, SLEEP_TIME_AFTER_SEAL);
	}
	else {
		setTimeout(defer.resolve, SLEEP_TIME);
	}
	return defer.promise
	.then(getStreamScreenshot);
}

getStreamScreenshot();