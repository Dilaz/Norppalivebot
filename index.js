const fs = require('fs');
const q = require('q');
const exec = require("child_process").exec
const shuffle = require('shuffle-array');
const moment = require('moment');
var AWS = require('aws-sdk');
AWS.config.loadFromPath('./config.json');
var rekognition = new AWS.Rekognition({apiVersion: '2016-06-27'});
var Twitter = require('twitter');

const MIN_HOUR = 5;
const MAX_HOUR = 22;
const SLEEP_TIME = 2 * 60 * 1000;
const SLEEP_TIME_AFTER_SEAL = 30 * 60 * 1000;
const IMAGENAME = 'norppa.png';
const STREAM = 'https://ams3-automatic-a04si.pukkistream.net:1936/abr/norppalive/live/norppalive_720p/chunks.m3u8';
const DETECTABLE = [
	'Seal',
	'Sea Lion',
];
const ALT_DETECTABLE = [
	'Animal',
	'Bird',
	'Duck',
	'Goose',
	'Mammal',
];
const DETECT_CONFIDENCE = 80;

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
	var time = moment().format('DD.MM.YYYY, HH:mm:ss');
	console.log('[%s] %s', time, msg);
}

/**
 * Class AWS Rekognition to find seals or mammals from the image
 * @return q.promise
 */
function detectSeals() {
	var params = {
		Image: {
			// Read file to bytestream
			Bytes: fs.readFileSync(IMAGENAME),
		},
		// Set minimum confidence
		MinConfidence: 35,
	};

	// Send the request
	return q.ninvoke(rekognition, 'detectLabels', params)
	.then(function(data) {
		// Go through the found labels
		for (var i in data.Labels) {
			var label = data.Labels[i];
			// If label matches given words, tweet it!
			if (DETECTABLE.indexOf(label.Name) !== -1) {
				log(label.Name + ' detected with confidence: ' + label.Confidence);
				// Save the image
				saveFile(data.Labels);
				console.log(data.Labels);

				// Only tweet if this is first time we've seen this seal
				if (!sealSeen && label.Confidence >= DETECT_CONFIDENCE) {
					sealSeen = true;
					return tweetNorppaIsLive(label.Confidence);
				}

				// If we've seen this already, just wait for a while
				return sleepForAWhile();
			}
			else if (ALT_DETECTABLE.indexOf(label.Name) !== -1) {
				console.log(data.Labels);
				saveFile(data.Labels);
			}
		}

		// No seals detected, sleep some more
		log('No seals detected');
		sealSeen = false;
		return sleepForAWhile();
	})
	.catch(console.log.bind(console));
}

/**
  * Copies norppa.png and current labels to images-directory with timestamp
  *
  * @param Array  labels  Labels from AWS
  * @return void
  */
function saveFile(labels) {
	if (!fs.existsSync(IMAGENAME)) {
		return;
	}
	var timestamp = moment().format('YYYY-MM-DD-HHmmss');

	log('Saving image to ' + timestamp + '.png ...');
	try {
		fs.writeFileSync('./images/' + timestamp + '.png', fs.readFileSync(IMAGENAME));
		fs.writeFileSync('./images/' + timestamp + '.log', JSON.stringify(labels));
	}
	catch (err) {
		console.log('Error: ', err);
	}
}

/**
 * Checks for hour limits and then takes a screenshot of the stream with ffmpeg
 * @return q.promise
 */
function getStreamScreenshot() {
	// Get current hour
	var hour = parseInt(moment().format('H'), 10);

	// If hour is not within the limits, just sleep more
	if (hour < MIN_HOUR || hour > MAX_HOUR) {
		sealSeen = false;
		return sleepForAWhile();
	}

	// Delete previous image if it exists
	if (fs.existsSync(IMAGENAME)) {
		fs.unlinkSync(IMAGENAME);
	}

	// Call ffmpeg to make a png image
	return q.nfcall(exec, 'ffmpeg -i "' + STREAM + '" -f image2  -vframes 1 ' + IMAGENAME)
	.then(detectSeals)
	.catch(function(e) {
		console.log(e);
		return getStreamScreenshot();
	});
}

/**
 * Tweets about norppa
 * @param  float confidence		AWS confidence
 * @return q.promise
 */
function tweetNorppaIsLive(confidence) {
	confidence = Math.round(confidence * 10) / 10;
	var message = messages[currentMessage] + ' (Varmuus: ' + confidence + '%)';

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
		log('Tweeted:' + message);
		currentMessage = (currentMessage + 1) % messages.length;
	})
	.then(function() {
		sleepForAWhile();
	});
}

/**
 * Sleeps for time period specified in SLEEP_TIME or SLEEP_TIME_AFTER_SEAL if
 * seal was recently detected. After that calls getStreamScreenshot()
 * @return void
 */
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

// Lights on, let's go
getStreamScreenshot();
