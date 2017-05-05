$(document).ready(function(){
	$("#button").click(function(e){
		var d = new Date();
		$("img").attr("src", "http://thecatapi.com/api/images/get?format=src&type=gif&ts="+d.getTime());
	});
});