/**
 * 用于测试 https://github.com/WqVoon/SimpleModuleLoader
 * 该脚本作为 define.config.paths.remote 被加载
 */
define('remote', function (require, exports) {
	exports.func = function () {
		console.log("From remote!")
	}
});