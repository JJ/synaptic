var __extends = this.__extends || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    __.prototype = b.prototype;
    d.prototype = new __();
};
var network = require('../network');
var trainer = require('../trainer');
var Layer = require('../layer');
var Squash = require('../squash');
var _utils = require('../utils');
var softmaxLayer = require('../softmaxLayer');
var Utils = _utils.Utils;
var NTM = (function (_super) {
    __extends(NTM, _super);
    function NTM(inputs, outputs, memBlocks, blockWidth, heads, hiddenSize) {
        // build the memory
        _super.call(this);
        this.heads = new Array();
        this.dirty = false;
        this.trainer = new trainer.Trainer(this);
        this.blocks = memBlocks;
        this.blockWidth = blockWidth;
        this.data = new Array(this.blocks);
        for (var index = 0; index < this.data.length; index++) {
            this.data[index] = new Float64Array(blockWidth);
        }
        this.clean();
        // build the network
        var inputLength = inputs + heads * memBlocks;
        this.inputValues = new Float64Array(inputLength);
        this.layers.input = this.inputLayer = new Layer.Layer(inputLength);
        this.hiddenLayer = new Layer.Layer(hiddenSize);
        this.layers.output = this.outputLayer = new Layer.Layer(outputs);
        this.inputLayer.project(this.hiddenLayer, Layer.Layer.connectionType.ALL_TO_ALL);
        this.hiddenLayer.project(this.outputLayer, Layer.Layer.connectionType.ALL_TO_ALL);
        var inputCounter = inputs - 1;
        for (var headIndex = 0; headIndex < heads; headIndex++) {
            this.addHead(this.inputValues.subarray(inputCounter, inputCounter + memBlocks));
            inputCounter += memBlocks;
        }
        this.optimized = false;
    }
    NTM.prototype.clean = function () {
        for (var location = 0; location < this.blocks; location++) {
            Utils.initRandomSoftmaxArray(this.data[location]);
        }
        this.dirty = false;
    };
    NTM.prototype.activate = function (input) {
        this.inputValues.set(input);
        this.inputLayer.activate(this.inputValues);
        this.hiddenLayer.activate();
        this.doTimeStep();
        return this.outputLayer.activate();
    };
    NTM.prototype.propagate = function (rate, target) {
        this.outputLayer.propagate(rate, target);
        for (var i = this.heads.length - 1; i >= 0; i--) {
            this.heads[i].shiftingLayer && this.heads[i].shiftingLayer.propagate(rate);
            this.heads[i].layer.propagate(rate);
        }
        this.hiddenLayer.propagate(rate);
        this.dirty = true;
    };
    NTM.prototype.addHead = function (subArray) {
        var head = new Head(this, subArray);
        this.heads.push(head);
        return head;
    };
    NTM.prototype.doTimeStep = function () {
        var _this = this;
        this.heads.forEach(function (head, headIndex) {
            head.doTimeStep();
        });
        // parallelizable
        this.heads.forEach(function (head, headIndex) {
            _this.doErase(head.w_weightings, head.eraseGate);
        });
        // parallelizable
        this.heads.forEach(function (head, headIndex) {
            _this.doAdd(head.w_weightings, head.addGate);
        });
        //this.data.forEach((e) => e = Utils.softMax(e))
    };
    NTM.prototype.doAdd = function (w, addGate) {
        for (var n = 0; n < this.blocks; n++) {
            var M = this.data[n];
            for (var i = 0; i < this.blockWidth; i++) {
                M[i] += addGate[n] * w[i];
            }
        }
    };
    NTM.prototype.doErase = function (w, eraseGate) {
        for (var n = 0; n < this.blocks; n++) {
            var M = this.data[n];
            for (var i = 0; i < this.blockWidth; i++) {
                M[i] *= 1 - eraseGate[n] * w[i];
            }
        }
    };
    return NTM;
})(network.Network);
exports.NTM = NTM;
var Head = (function () {
    function Head(memory, destinationArray) {
        this.s_shiftingValue = null;
        this.prevFocus = 1;
        this.memory = memory;
        this.wc_focusedWeights = new Float64Array(this.memory.blocks);
        this.w_weightings = new Float64Array(this.memory.blocks);
        Utils.initRandomSoftmaxArray(this.w_weightings);
        this.shiftLength = 3; //this.memory.blocks;
        this.k_keys = new Float64Array(this.memory.blockWidth);
        this.ß_keyStrength = 0;
        this.eraseGate = new Float64Array(this.memory.blocks);
        this.addGate = new Float64Array(this.memory.blocks);
        this.readVector = destinationArray || new Float64Array(this.memory.blocks);
        // Head layer
        this.layer = new Layer.Layer(this.memory.blockWidth + this.memory.blocks * 3 + Head.ADDITIONAL_INPUT_VALUES, "NTM: Head layer");
        this.memory.hiddenLayer.project(this.layer, Layer.Layer.connectionType.ALL_TO_ALL);
        this.layer.project(this.memory.outputLayer, Layer.Layer.connectionType.ALL_TO_ALL);
        // shifting layer
        this.shiftingLayer = new softmaxLayer.SoftMaxLayer(this.shiftLength, "NTM: Shifting layer");
        this.memory.hiddenLayer.project(this.shiftingLayer, Layer.Layer.connectionType.ALL_TO_ALL);
        this.shiftingLayer.project(this.memory.hiddenLayer, Layer.Layer.connectionType.ALL_TO_ALL);
        this.s_shiftingVector = this.shiftingLayer.currentActivation;
    }
    Head.prototype.readParams = function (activation) {
        this.ß_keyStrength = activation[0];
        this.g_interpolation = activation[1];
        this.Y_focus = activation[2] + 1; //Squash.SOFTPLUS(activation[2]) + 1;
        var startAt = 3;
        for (var k = 0; k < this.k_keys.length; k++) {
            this.k_keys[k] = this.layer.list[k + startAt].activation;
        }
        startAt += this.k_keys.length;
        for (var k = 0; k < this.addGate.length; k++) {
            this.addGate[k] = this.layer.list[k + startAt].activation;
        }
        startAt += this.addGate.length;
        for (var k = 0; k < this.eraseGate.length; k++) {
            this.eraseGate[k] = Squash.LOGISTIC(this.layer.list[k + startAt].activation);
        }
        var M = this.memory.data;
        for (var i = 0; i < M.length; i++)
            this.wc_focusedWeights[i] = Utils.getCosineSimilarity(M[i], this.k_keys) * this.ß_keyStrength;
        Utils.softMax(this.wc_focusedWeights);
        // focus by location (interpolation)
        Utils.interpolateArray(this.wc_focusedWeights, this.w_weightings, this.g_interpolation);
        // convolutional shift
        //this.doShiftings();
        Utils.vectorInvertedShifting(this.wc_focusedWeights, this.s_shiftingVector);
        // sharpening
        Utils.sharpArray(this.w_weightings, this.wc_focusedWeights, this.Y_focus);
        // since ∑ w = 1, we have to softmax the array
        Utils.softMax(this.w_weightings);
        /// we got wt!
    };
    Head.prototype.doShiftings = function () {
        // call this fn in case of not using a softmaxLayer for shifting
        Utils.softMax(this.s_shiftingVector);
        Utils.vectorInvertedShifting(this.wc_focusedWeights, this.s_shiftingVector);
    };
    Head.prototype.doTimeStep = function () {
        var activation = this.layer.activate();
        this.shiftingLayer && this.shiftingLayer.activate();
        this.readParams(activation);
        for (var index = 0; index < this.memory.blocks; index++) {
            this.readVector[index] = 0;
            for (var cell = 0; cell < this.memory.blockWidth; cell++) {
                this.readVector[index] += this.memory.data[index][cell] * this.w_weightings[index];
            }
        }
    };
    Head.ADDITIONAL_INPUT_VALUES = 3;
    return Head;
})();
exports.Head = Head;

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInNyYy9hcmNoaXRlY3QvTlRNLnRzIl0sIm5hbWVzIjpbIk5UTSIsIk5UTS5jb25zdHJ1Y3RvciIsIk5UTS5jbGVhbiIsIk5UTS5hY3RpdmF0ZSIsIk5UTS5wcm9wYWdhdGUiLCJOVE0uYWRkSGVhZCIsIk5UTS5kb1RpbWVTdGVwIiwiTlRNLmRvQWRkIiwiTlRNLmRvRXJhc2UiLCJIZWFkIiwiSGVhZC5jb25zdHJ1Y3RvciIsIkhlYWQucmVhZFBhcmFtcyIsIkhlYWQuZG9TaGlmdGluZ3MiLCJIZWFkLmRvVGltZVN0ZXAiXSwibWFwcGluZ3MiOiI7Ozs7OztBQUFBLElBQU8sT0FBTyxXQUFXLFlBQVksQ0FBQyxDQUFDO0FBQ3ZDLElBQU8sT0FBTyxXQUFXLFlBQVksQ0FBQyxDQUFDO0FBQ3ZDLElBQU8sS0FBSyxXQUFXLFVBQVUsQ0FBQyxDQUFDO0FBR25DLElBQU8sTUFBTSxXQUFXLFdBQVcsQ0FBQyxDQUFDO0FBQ3JDLElBQU8sTUFBTSxXQUFXLFVBQVUsQ0FBQyxDQUFDO0FBQ3BDLElBQU8sWUFBWSxXQUFXLGlCQUFpQixDQUFDLENBQUM7QUFFakQsSUFBSSxLQUFLLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQztBQUV6QixJQUFhLEdBQUc7SUFBU0EsVUFBWkEsR0FBR0EsVUFBd0JBO0lBa0J0Q0EsU0FsQldBLEdBQUdBLENBa0JGQSxNQUFjQSxFQUFFQSxPQUFlQSxFQUFFQSxTQUFpQkEsRUFBRUEsVUFBa0JBLEVBQUVBLEtBQWFBLEVBQUVBLFVBQWtCQTtRQUNuSEMsbUJBQW1CQTtRQUVuQkEsaUJBQU9BLENBQUNBO1FBYlZBLFVBQUtBLEdBQVdBLElBQUlBLEtBQUtBLEVBQUVBLENBQUNBO1FBUTVCQSxVQUFLQSxHQUFHQSxLQUFLQSxDQUFDQTtRQU9aQSxJQUFJQSxDQUFDQSxPQUFPQSxHQUFHQSxJQUFJQSxPQUFPQSxDQUFDQSxPQUFPQSxDQUFDQSxJQUFJQSxDQUFDQSxDQUFDQTtRQUV6Q0EsSUFBSUEsQ0FBQ0EsTUFBTUEsR0FBR0EsU0FBU0Es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QUFXQSxDQUFDQSxHQUFHQSxDQUFNQSxLQUFLQSxDQUFDQSxDQUFDQTtRQUVqQ0EsSUFBSUEsQ0FBQ0EsVUFBVUEsQ0FBQ0EsUUFBUUEsQ0FBQ0EsSUFBSUEsQ0FBQ0EsV0FBV0EsQ0FBQ0EsQ0FBQ0E7UUFDM0NBLElBQUlBLENBQUNBLFdBQVdBLENBQUNBLFFBQVFBLEVBQUVBLENBQUNBO1FBRTVCQSxJQUFJQSxDQUFDQSxVQUFVQSxFQUFFQSxDQUFDQTtRQUVsQkEsTUFBTUEsQ0FBQ0EsSUFBSUEsQ0FBQ0EsV0FBV0EsQ0FBQ0EsUUFBUUEsRUFBRUEsQ0FBQ0E7SUFDckNBLENBQUNBO0lBRURILHVCQUFTQSxHQUFUQSxVQUFVQSxJQUFZQSxFQUFFQSxNQUE4QkE7UUFDcERJLElBQUlBLENBQUNBLFdBQVdBLENBQUNBLFNBQVNBLENBQUNBLElBQUlBLEVBQUVBLE1BQU1BLENBQUNBLENBQUNBO1FBQ3pDQSxHQUFHQSxDQUFDQSxDQUFDQSxHQUFHQSxDQUFDQSxDQUFDQSxHQUFHQSxJQUFJQSxDQUFDQSxLQUFLQSxDQUFDQSxNQUFNQSxHQUFHQSxDQUFDQSxFQUFFQSxDQUFDQSxJQUFJQSxDQUFDQSxFQUFFQSxDQUFDQSxFQUFFQSxFQUFFQSxDQUFDQTtZQUNoREEsSUFBSUEsQ0FBQ0EsS0FBS0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsYUFBYUEsSUFBSUEsSUFBSUEsQ0FBQ0EsS0FBS0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsYUFBYUEsQ0FBQ0EsU0FBU0EsQ0FBQ0EsSUFBSUEsQ0FBQ0EsQ0FBQ0E7WUFDM0VBLElBQUlBLENBQUNBLEtBQUtBLENBQUNBLENBQUNBLENBQUNBLENBQUNBLEtBQUtBLENBQUNBLFNBQVNBLENBQUNBLElBQUlBLENBQUNBLENBQUNBO1FBQ3RDQSxDQUFDQTtRQUNEQSxJQUFJQSxDQUFDQSxXQUFXQSxDQUFDQSxTQUFTQSxDQUFDQSxJQUFJQSxDQUFDQSxDQUFDQTtRQUNqQ0EsSUFBSUEsQ0FBQ0EsS0FBS0EsR0FBR0EsSUFBSUEsQ0FBQ0E7SUFDcEJBLENBQUNBO0lBRURKLHFCQUFPQSxHQUFQQSxVQUFRQSxRQUFzQkE7UUFDNUJLLElBQUlBLElBQUlBLEdBQUdBLElBQUlBLElBQUlBLENBQUNBLElBQUlBLEVBQUVBLFFBQVFBLENBQUNBLENBQUNBO1FBQ3BDQSxJQUFJQSxDQUFDQSxLQUFLQSxDQUFDQSxJQUFJQSxDQUFDQSxJQUFJQSxDQUFDQSxDQUFDQTtRQUN0QkEsTUFBTUEsQ0FBQ0EsSUFBSUEsQ0FBQ0E7SUFDZEEsQ0FBQ0E7SUFFREwsd0JBQVVBLEdBQVZBO1FBQUFNLGlCQWdCQ0E7UUFmQ0EsSUFBSUEsQ0FBQ0EsS0FBS0EsQ0FBQ0EsT0FBT0EsQ0FBQ0EsVUFBQ0EsSUFBSUEsRUFBRUEsU0FBU0E7WUFDakNBLElBQUlBLENBQUNBLFVBQVVBLEVBQUVBLENBQUNBO1FBQ3BCQSxDQUFDQSxDQUFDQSxDQUFDQTtRQUVIQSxBQUNBQSxpQkFEaUJBO1FBQ2pCQSxJQUFJQSxDQUFDQSxLQUFLQSxDQUFDQSxPQUFPQSxDQUFDQSxVQUFDQSxJQUFJQSxFQUFFQSxTQUFTQTtZQUNqQ0EsS0FBSUEsQ0FBQ0EsT0FBT0EsQ0FBQ0EsSUFBSUEsQ0FBQ0EsWUFBWUEsRUFBRUEsSUFBSUEsQ0FBQ0EsU0FBU0EsQ0FBQ0EsQ0FBQ0E7UUFDbERBLENBQUNBLENBQUNBLENBQUNBO1FBRUhBLEFBQ0FBLGlCQURpQkE7UUFDakJBLElBQUlBLENBQUNBLEtBQUtBLENBQUNBLE9BQU9BLENBQUNBLFVBQUNBLElBQUlBLEVBQUVBLFNBQVNBO1lBQ2pDQSxLQUFJQSxDQUFDQSxLQUFLQSxDQUFDQSxJQUFJQSxDQUFDQSxZQUFZQSxFQUFFQSxJQUFJQSxDQUFDQSxPQUFPQSxDQUFDQSxDQUFDQTtRQUM5Q0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0E7UUFFSEEsZ0RBQWdEQTtJQUNsREEsQ0FBQ0E7SUFFRE4sbUJBQUtBLEdBQUxBLFVBQU1BLENBQXlCQSxFQUFFQSxPQUErQkE7UUFDOURPLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLEVBQUVBLENBQUNBLEdBQUdBLElBQUlBLENBQUNBLE1BQU1BLEVBQUVBLENBQUNBLEVBQUVBLEVBQUVBLENBQUNBO1lBQ3JDQSxJQUFJQSxDQUFDQSxHQUFHQSxJQUFJQSxDQUFDQSxJQUFJQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQTtZQUNyQkEsR0FBR0EsQ0FBQ0EsQ0FBQ0EsR0FBR0EsQ0FBQ0EsQ0FBQ0EsR0FBR0EsQ0FBQ0EsRUFBRUEsQ0FBQ0EsR0FBR0EsSUFBSUEsQ0FBQ0EsVUFBVUEsRUFBRUEsQ0FBQ0EsRUFBRUEsRUFBRUEsQ0FBQ0E7Z0JBQ3pDQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQSxJQUFJQSxPQUFPQSxDQUFDQSxDQUFDQSxDQUFDQSxHQUFHQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQTtZQUM1QkEsQ0FBQ0E7UUFDSEEsQ0FBQ0E7SUFDSEEsQ0FBQ0E7SUFFRFAscUJBQU9BLEdBQVBBLFVBQVFBLENBQXlCQSxFQUFFQSxTQUFpQ0E7UUFDbEVRLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLEVBQUVBLENBQUNBLEdBQUdBLElBQUlBLENBQUNBLE1BQU1BLEVBQUVBLENBQUNBLEVBQUVBLEVBQUVBLENBQUNBO1lBQ3JDQSxJQUFJQSxDQUFDQSxHQUFHQSxJQUFJQSxDQUFDQSxJQUFJQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQTtZQUNyQkEsR0FBR0EsQ0FBQ0EsQ0FBQ0EsR0FBR0EsQ0FBQ0EsQ0FBQ0EsR0FBR0EsQ0FBQ0EsRUFBRUEsQ0FBQ0EsR0FBR0EsSUFBSUEsQ0FBQ0EsVUFBVUEsRUFBRUEsQ0FBQ0EsRUFBRUEsRUFBRUEsQ0FBQ0E7Z0JBQ3pDQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQSxJQUFJQSxDQUFDQSxHQUFHQSxTQUFTQSxDQUFDQSxDQUFDQSxDQUFDQSxHQUFHQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQSxDQUFDQTtZQUNsQ0EsQ0FBQ0E7UUFDSEEsQ0FBQ0E7SUFDSEEsQ0FBQ0E7SUFDSFIsVUFBQ0E7QUFBREEs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QSxLQUFLQSxDQUFDQSxJQUFJQSxDQUFDQSxDQUFDQSxHQUFHQSxPQUFPQSxDQUFDQSxDQUFDQSxVQUFVQSxDQUFDQTtRQUM1REEsQ0FBQ0E7UUFFREEsT0FBT0EsSUFBSUEsSUFBSUEsQ0FBQ0EsT0FBT0EsQ0FBQ0EsTUFBTUEsQ0FBQ0E7UUFDL0JBLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLEVBQUVBLENBQUNBLEdBQUdBLElBQUlBLENBQUNBLFNBQVNBLENBQUNBLE1BQU1BLEVBQUVBLENBQUNBLEVBQUVBLEVBQUVBLENBQUNBO1lBQy9DQSxJQUFJQSxDQUFDQSxTQUFTQSxDQUFDQSxDQUFDQSxDQUFDQSxHQUFHQSxNQUFNQSxDQUFDQSxRQUFRQSxDQUFDQSxJQUFJQSxDQUFDQSxLQUFLQSxDQUFDQSxJQUFJQSxDQUFDQSxDQUFDQSxHQUFHQSxPQUFPQSxDQUFDQSxDQUFDQSxVQUFVQSxDQUFDQSxDQUFDQTtRQUMvRUEsQ0FBQ0E7UUFFREEsSUFBSUEsQ0FBQ0EsR0FBR0EsSUFBSUEsQ0FBQ0EsTUFBTUEsQ0FBQ0EsSUFBSUEsQ0FBQ0E7UUFHekJBLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBLEdBQUdBLENBQUNBLEVBQUVBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBLE1BQU1BLEVBQUVBLENBQUNBLEVBQUVBO1lBQy9CQSxJQUFJQSxDQUFDQSxpQkFBaUJBLENBQUNBLENBQUNBLENBQUNBLEdBQUdBLEtBQUtBLENBQUNBLG1CQUFtQkEsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsQ0FBQ0EsRUFBRUEsSUFBSUEsQ0FBQ0EsTUFBTUEsQ0FBQ0EsR0FBR0EsSUFBSUEsQ0FBQ0EsYUFBYUEsQ0FBQ0E7UUFFaEdBLEtBQUtBLENBQUNBLE9BQU9BLENBQUNBLElBQUlBLENBQUNBLGlCQUFpQkEsQ0FBQ0EsQ0FBQ0E7UUFFdENBLEFBQ0FBLG9DQURvQ0E7UUFDcENBLEtBQUtBLENBQUNBLGdCQUFnQkEsQ0FBQ0EsSUFBSUEsQ0FBQ0EsaUJBQWlCQSxFQUFFQSxJQUFJQSxDQUFDQSxZQUFZQSxFQUFFQSxJQUFJQSxDQUFDQSxlQUFlQSxDQUFDQSxDQUFDQTtRQUV4RkEsQUFFQUEsc0JBRnNCQTtRQUN0QkEscUJBQXFCQTtRQUNyQkEsS0FBS0EsQ0FBQ0Esc0JBQXNCQSxDQUFDQSxJQUFJQSxDQUFDQSxpQkFBaUJBLEVBQUVBLElBQUlBLENBQUNBLGdCQUFnQkEsQ0FBQ0EsQ0FBQ0E7UUFFNUVBLEFBQ0FBLGFBRGFBO1FBQ2JBLEtBQUtBLENBQUNBLFVBQVVBLENBQUNBLElBQUlBLENBQUNBLFlBQVlBLEVBQUVBLElBQUlBLENBQUNBLGlCQUFpQkEsRUFBRUEsSUFBSUEsQ0FBQ0EsT0FBT0EsQ0FBQ0EsQ0FBQ0E7UUFFMUVBLEFBQ0FBLDhDQUQ4Q0E7UUFDOUNBLEtBQUtBLENBQUNBLE9BQU9BLENBQUNBLElBQUlBLENBQUNBLFlBQVlBLENBQUNBLENBQUNBO1FBRWpDQSxjQUFjQTtJQUNoQkEsQ0FBQ0E7SUFFREYsMEJBQVdBLEdBQVhBO1FBQ0VHLGdFQUFnRUE7UUFFaEVBLEtBQUtBLENBQUNBLE9BQU9BLENBQUNBLElBQUlBLENBQUNBLGdCQUFnQkEsQ0FBQ0EsQ0FBQ0E7UUFDckNBLEtBQUtBLENBQUNBLHNCQUFzQkEsQ0FBQ0EsSUFBSUEsQ0FBQ0EsaUJBQWlCQSxFQUFFQSxJQUFJQSxDQUFDQSxnQkFBZ0JBLENBQUNBLENBQUNBO0lBQzlFQSxDQUFDQTtJQUVESCx5QkFBVUEsR0FBVkE7UUFDRUksSUFBSUEsVUFBVUEsR0FBR0EsSUFBSUEsQ0FBQ0EsS0FBS0EsQ0FBQ0EsUUFBUUEsRUFBRUEsQ0FBQ0E7UUFFdkNBLElBQUlBLENBQUNBLGFBQWFBLElBQUlBLElBQUlBLENBQUNBLGFBQWFBLENBQUNBLFFBQVFBLEVBQUVBLENBQUNBO1FBRXBEQSxJQUFJQSxDQUFDQSxVQUFVQSxDQUFDQSxVQUFVQSxDQUFDQSxDQUFDQTtRQUc1QkEsR0FBR0EsQ0FBQ0EsQ0FBQ0EsR0FBR0EsQ0FBQ0EsS0FBS0EsR0FBR0EsQ0FBQ0EsRUFBRUEsS0FBS0EsR0FBR0EsSUFBSUEsQ0FBQ0EsTUFBTUEsQ0FBQ0EsTUFBTUEsRUFBRUEsS0FBS0EsRUFBRUEsRUFBRUEsQ0FBQ0E7WUFDeERBLElBQUlBLENBQUNBLFVBQVVBLENBQUNBLEtBQUtBLENBQUNBLEdBQUdBLENBQUNBLENBQUNBO1lBQzNCQSxHQUFHQSxDQUFDQSxDQUFDQSxHQUFHQSxDQUFDQSxJQUFJQSxHQUFHQSxDQUFDQSxFQUFFQSxJQUFJQSxHQUFHQSxJQUFJQSxDQUFDQSxNQUFNQSxDQUFDQSxVQUFVQSxFQUFFQSxJQUFJQSxFQUFFQSxFQUFFQSxDQUFDQTtnQkFDekRBLElBQUlBLENBQUNBLFVBQVVBLENBQUNBLEtBQUtBLENBQUNBLElBQUlBLElBQUlBLENBQUNBLE1BQU1BLENBQUNBLElBQUlBLENBQUNBLEtBQUtBLENBQUNBLENBQUNBLElBQUlBLENBQUNBLEdBQUdBLElBQUlBLENBQUNBLFlBQVlBLENBQUNBLEtBQUtBLENBQUNBLENBQUNBO1lBQ3JGQSxDQUFDQTtRQUNIQSxDQUFDQTtJQUNIQSxDQUFDQTtJQXBITUosNEJBQXVCQSxHQUFHQSxDQUFDQSxDQUFDQTtJQXFIckNBLFdBQUNBO0FBQURBLENBdEhBLEFBc0hDQSxJQUFBO0FBdEhZLFlBQUksR0FBSixJQXNIWixDQUFBIiwiZmlsZSI6InNyYy9hcmNoaXRlY3QvTlRNLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IG5ldHdvcmsgPSByZXF1aXJlKCcuLi9uZXR3b3JrJyk7XG5pbXBvcnQgdHJhaW5lciA9IHJlcXVpcmUoJy4uL3RyYWluZXInKTtcbmltcG9ydCBMYXllciA9IHJlcXVpcmUoJy4uL2xheWVyJyk7XG5pbXBvcnQgbmV1cm9uID0gcmVxdWlyZSgnLi4vbmV1cm9uJyk7XG5pbXBvcnQgU3luYXB0aWMgPSByZXF1aXJlKCcuLi9zeW5hcHRpYycpO1xuaW1wb3J0IFNxdWFzaCA9IHJlcXVpcmUoJy4uL3NxdWFzaCcpO1xuaW1wb3J0IF91dGlscyA9IHJlcXVpcmUoJy4uL3V0aWxzJyk7XG5pbXBvcnQgc29mdG1heExheWVyID0gcmVxdWlyZSgnLi4vc29mdG1heExheWVyJyk7XG5cbnZhciBVdGlscyA9IF91dGlscy5VdGlscztcblxuZXhwb3J0IGNsYXNzIE5UTSBleHRlbmRzIG5ldHdvcmsuTmV0d29yayB7XG4gIHRyYWluZXI6IHRyYWluZXIuVHJhaW5lcjtcblxuICBkYXRhOiBGbG9hdDY0QXJyYXlbXTtcblxuICBibG9ja1dpZHRoOiBudW1iZXI7XG4gIGJsb2NrczogbnVtYmVyO1xuXG4gIGhlYWRzOiBIZWFkW10gPSBuZXcgQXJyYXkoKTtcblxuICBpbnB1dFZhbHVlczogRmxvYXQ2NEFycmF5O1xuXG4gIGlucHV0TGF5ZXI6IExheWVyLkxheWVyO1xuICBoaWRkZW5MYXllcjogTGF5ZXIuTGF5ZXI7XG4gIG91dHB1dExheWVyOiBMYXllci5MYXllcjtcblxuICBkaXJ0eSA9IGZhbHNlO1xuXG4gIGNvbnN0cnVjdG9yKGlucHV0czogbnVtYmVyLCBvdXRwdXRzOiBudW1iZXIsIG1lbUJsb2NrczogbnVtYmVyLCBibG9ja1dpZHRoOiBudW1iZXIsIGhlYWRzOiBudW1iZXIsIGhpZGRlblNpemU6IG51bWJlcikge1xuICAgIC8vIGJ1aWxkIHRoZSBtZW1vcnlcbiAgICBcbiAgICBzdXBlcigpO1xuXG4gICAgdGhpcy50cmFpbmVyID0gbmV3IHRyYWluZXIuVHJhaW5lcih0aGlzKTtcblxuICAgIHRoaXMuYmxvY2tzID0gbWVtQmxvY2tzO1xuICAgIHRoaXMuYmxvY2tXaWR0aCA9IGJsb2NrV2lkdGg7XG5cbiAgICB0aGlzLmRhdGEgPSBuZXcgQXJyYXkodGhpcy5ibG9ja3MpO1xuICAgIGZvciAodmFyIGluZGV4ID0gMDsgaW5kZXggPCB0aGlzLmRhdGEubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgICB0aGlzLmRhdGFbaW5kZXhdID0gbmV3IEZsb2F0NjRBcnJheShibG9ja1dpZHRoKTtcblxuICAgIH1cblxuICAgIHRoaXMuY2xlYW4oKTtcbiAgICBcbiAgICAvLyBidWlsZCB0aGUgbmV0d29ya1xuICAgIFxuICAgIHZhciBpbnB1dExlbmd0aCA9IGlucHV0cyArIGhlYWRzICogbWVtQmxvY2tzO1xuXG4gICAgdGhpcy5pbnB1dFZhbHVlcyA9IG5ldyBGbG9hdDY0QXJyYXkoaW5wdXRMZW5ndGgpO1xuXG4gICAgdGhpcy5sYXllcnMuaW5wdXQgPSB0aGlzLmlucHV0TGF5ZXIgPSBuZXcgTGF5ZXIuTGF5ZXIoaW5wdXRMZW5ndGgpO1xuICAgIHRoaXMuaGlkZGVuTGF5ZXIgPSBuZXcgTGF5ZXIuTGF5ZXIoaGlkZGVuU2l6ZSk7XG4gICAgdGhpcy5sYXllcnMub3V0cHV0ID0gdGhpcy5vdXRwdXRMYXllciA9IG5ldyBMYXllci5MYXllcihvdXRwdXRzKTtcblxuXG5cbiAgICB0aGlzLmlucHV0TGF5ZXIucHJvamVjdCh0aGlzLmhpZGRlbkxheWVyLCBMYXllci5MYXllci5jb25uZWN0aW9uVHlwZS5BTExfVE9fQUxMKTtcbiAgICB0aGlzLmhpZGRlbkxheWVyLnByb2plY3QodGhpcy5vdXRwdXRMYXllciwgTGF5ZXIuTGF5ZXIuY29ubmVjdGlvblR5cGUuQUxMX1RPX0FMTCk7XG5cbiAgICB2YXIgaW5wdXRDb3VudGVyID0gaW5wdXRzIC0gMTtcblxuICAgIGZvciAodmFyIGhlYWRJbmRleCA9IDA7IGhlYWRJbmRleCA8IGhlYWRzOyBoZWFkSW5kZXgrKykge1xuICAgICAgdGhpcy5hZGRIZWFkKHRoaXMuaW5wdXRWYWx1ZXMuc3ViYXJyYXkoaW5wdXRDb3VudGVyLCBpbnB1dENvdW50ZXIgKyBtZW1CbG9ja3MpKTtcbiAgICAgIGlucHV0Q291bnRlciArPSBtZW1CbG9ja3M7XG4gICAgfVxuXG4gICAgdGhpcy5vcHRpbWl6ZWQgPSBmYWxzZTtcbiAgfVxuXG4gIGNsZWFuKCkge1xuICAgIGZvciAodmFyIGxvY2F0aW9uID0gMDsgbG9jYXRpb24gPCB0aGlzLmJsb2NrczsgbG9jYXRpb24rKykge1xuICAgICAgVXRpbHMuaW5pdFJhbmRvbVNvZnRtYXhBcnJheSh0aGlzLmRhdGFbbG9jYXRpb25dKTtcbiAgICB9XG4gICAgdGhpcy5kaXJ0eSA9IGZhbHNlO1xuICB9XG5cbiAgYWN0aXZhdGUoaW5wdXQ6IFN5bmFwdGljLklOdW1lcmljQXJyYXkpIHtcbiAgICB0aGlzLmlucHV0VmFsdWVzLnNldCg8YW55PmlucHV0KTtcblxuICAgIHRoaXMuaW5wdXRMYXllci5hY3RpdmF0ZSh0aGlzLmlucHV0VmFsdWVzKTtcbiAgICB0aGlzLmhpZGRlbkxheWVyLmFjdGl2YXRlKCk7XG5cbiAgICB0aGlzLmRvVGltZVN0ZXAoKTtcblxuICAgIHJldHVybiB0aGlzLm91dHB1dExheWVyLmFjdGl2YXRlKCk7XG4gIH1cblxuICBwcm9wYWdhdGUocmF0ZTogbnVtYmVyLCB0YXJnZXQ6IFN5bmFwdGljLklOdW1lcmljQXJyYXkpIHtcbiAgICB0aGlzLm91dHB1dExheWVyLnByb3BhZ2F0ZShyYXRlLCB0YXJnZXQpO1xuICAgIGZvciAodmFyIGkgPSB0aGlzLmhlYWRzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgICB0aGlzLmhlYWRzW2ldLnNoaWZ0aW5nTGF5ZXIgJiYgdGhpcy5oZWFkc1tpXS5zaGlmdGluZ0xheWVyLnByb3BhZ2F0ZShyYXRlKTtcbiAgICAgIHRoaXMuaGVhZHNbaV0ubGF5ZXIucHJvcGFnYXRlKHJhdGUpO1xuICAgIH1cbiAgICB0aGlzLmhpZGRlbkxheWVyLnByb3BhZ2F0ZShyYXRlKTtcbiAgICB0aGlzLmRpcnR5ID0gdHJ1ZTtcbiAgfVxuXG4gIGFkZEhlYWQoc3ViQXJyYXk6IEZsb2F0NjRBcnJheSk6IEhlYWQge1xuICAgIHZhciBoZWFkID0gbmV3IEhlYWQodGhpcywgc3ViQXJyYXkpO1xuICAgIHRoaXMuaGVhZHMucHVzaChoZWFkKTtcbiAgICByZXR1cm4gaGVhZDtcbiAgfVxuXG4gIGRvVGltZVN0ZXAoKSB7XG4gICAgdGhpcy5oZWFkcy5mb3JFYWNoKChoZWFkLCBoZWFkSW5kZXgpID0+IHtcbiAgICAgIGhlYWQuZG9UaW1lU3RlcCgpO1xuICAgIH0pO1xuICAgIFxuICAgIC8vIHBhcmFsbGVsaXphYmxlXG4gICAgdGhpcy5oZWFkcy5mb3JFYWNoKChoZWFkLCBoZWFkSW5kZXgpID0+IHtcbiAgICAgIHRoaXMuZG9FcmFzZShoZWFkLndfd2VpZ2h0aW5ncywgaGVhZC5lcmFzZUdhdGUpO1xuICAgIH0pO1xuICAgIFxuICAgIC8vIHBhcmFsbGVsaXphYmxlXG4gICAgdGhpcy5oZWFkcy5mb3JFYWNoKChoZWFkLCBoZWFkSW5kZXgpID0+IHtcbiAgICAgIHRoaXMuZG9BZGQoaGVhZC53X3dlaWdodGluZ3MsIGhlYWQuYWRkR2F0ZSk7XG4gICAgfSk7XG4gICAgXG4gICAgLy90aGlzLmRhdGEuZm9yRWFjaCgoZSkgPT4gZSA9IFV0aWxzLnNvZnRNYXgoZSkpXG4gIH1cblxuICBkb0FkZCh3OiBTeW5hcHRpYy5JTnVtZXJpY0FycmF5LCBhZGRHYXRlOiBTeW5hcHRpYy5JTnVtZXJpY0FycmF5KSB7XG4gICAgZm9yICh2YXIgbiA9IDA7IG4gPCB0aGlzLmJsb2NrczsgbisrKSB7XG4gICAgICB2YXIgTSA9IHRoaXMuZGF0YVtuXTtcbiAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgdGhpcy5ibG9ja1dpZHRoOyBpKyspIHtcbiAgICAgICAgTVtpXSArPSBhZGRHYXRlW25dICogd1tpXTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBkb0VyYXNlKHc6IFN5bmFwdGljLklOdW1lcmljQXJyYXksIGVyYXNlR2F0ZTogU3luYXB0aWMuSU51bWVyaWNBcnJheSkge1xuICAgIGZvciAodmFyIG4gPSAwOyBuIDwgdGhpcy5ibG9ja3M7IG4rKykge1xuICAgICAgdmFyIE0gPSB0aGlzLmRhdGFbbl07XG4gICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHRoaXMuYmxvY2tXaWR0aDsgaSsrKSB7XG4gICAgICAgIE1baV0gKj0gMSAtIGVyYXNlR2F0ZVtuXSAqIHdbaV07XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cblxuXG5leHBvcnQgY2xhc3MgSGVhZCB7XG4gIHN0YXRpYyBBRERJVElPTkFMX0lOUFVUX1ZBTFVFUyA9IDM7XG5cbiAgbWVtb3J5OiBOVE07XG5cbiAgd193ZWlnaHRpbmdzOiBGbG9hdDY0QXJyYXk7XG4gIGVyYXNlR2F0ZTogRmxvYXQ2NEFycmF5O1xuICBhZGRHYXRlOiBGbG9hdDY0QXJyYXk7XG4gIGtfa2V5czogRmxvYXQ2NEFycmF5O1xuICBnX2ludGVycG9sYXRpb246IG51bWJlcjtcbiAgWV9mb2N1czogbnVtYmVyO1xuICBzX3NoaWZ0aW5nVmFsdWU6IG51bWJlciA9IG51bGw7XG4gIHNfc2hpZnRpbmdWZWN0b3I6IEZsb2F0NjRBcnJheTtcbiAgd2NfZm9jdXNlZFdlaWdodHM6IEZsb2F0NjRBcnJheTtcbiAgcmVhZFZlY3RvcjogRmxvYXQ2NEFycmF5O1xuICDDn19rZXlTdHJlbmd0aDogbnVtYmVyO1xuICBwcmV2Rm9jdXM6IG51bWJlciA9IDE7XG5cbiAgc2hpZnRMZW5ndGg6IG51bWJlcjtcblxuICBsYXllcjogTGF5ZXIuTGF5ZXI7XG4gIHNoaWZ0aW5nTGF5ZXI6IExheWVyLkxheWVyO1xuXG4gIGNvbnN0cnVjdG9yKG1lbW9yeTogTlRNLCBkZXN0aW5hdGlvbkFycmF5PzogRmxvYXQ2NEFycmF5KSB7XG4gICAgdGhpcy5tZW1vcnkgPSBtZW1vcnk7XG4gICAgdGhpcy53Y19mb2N1c2VkV2VpZ2h0cyA9IG5ldyBGbG9hdDY0QXJyYXkodGhpcy5tZW1vcnkuYmxvY2tzKTtcbiAgICB0aGlzLndfd2VpZ2h0aW5ncyA9IG5ldyBGbG9hdDY0QXJyYXkodGhpcy5tZW1vcnkuYmxvY2tzKTtcblxuICAgIFV0aWxzLmluaXRSYW5kb21Tb2Z0bWF4QXJyYXkodGhpcy53X3dlaWdodGluZ3MpO1xuXG4gICAgdGhpcy5zaGlmdExlbmd0aCA9IDM7IC8vdGhpcy5tZW1vcnkuYmxvY2tzO1xuXG4gICAgXG4gICAgdGhpcy5rX2tleXMgPSBuZXcgRmxvYXQ2NEFycmF5KHRoaXMubWVtb3J5LmJsb2NrV2lkdGgpO1xuICAgIHRoaXMuw59fa2V5U3RyZW5ndGggPSAwO1xuICAgIHRoaXMuZXJhc2VHYXRlID0gbmV3IEZsb2F0NjRBcnJheSh0aGlzLm1lbW9yeS5ibG9ja3MpO1xuICAgIHRoaXMuYWRkR2F0ZSA9IG5ldyBGbG9hdDY0QXJyYXkodGhpcy5tZW1vcnkuYmxvY2tzKTtcbiAgICB0aGlzLnJlYWRWZWN0b3IgPSBkZXN0aW5hdGlvbkFycmF5IHx8IG5ldyBGbG9hdDY0QXJyYXkodGhpcy5tZW1vcnkuYmxvY2tzKTtcblxuICAgIC8vIEhlYWQgbGF5ZXJcbiAgICB0aGlzLmxheWVyID0gbmV3IExheWVyLkxheWVyKHRoaXMubWVtb3J5LmJsb2NrV2lkdGggKyB0aGlzLm1lbW9yeS5ibG9ja3MgKiAzICsgSGVhZC5BRERJVElPTkFMX0lOUFVUX1ZBTFVFUywgXCJOVE06IEhlYWQgbGF5ZXJcIik7XG4gICAgdGhpcy5tZW1vcnkuaGlkZGVuTGF5ZXIucHJvamVjdCh0aGlzLmxheWVyLCBMYXllci5MYXllci5jb25uZWN0aW9uVHlwZS5BTExfVE9fQUxMKTtcbiAgICB0aGlzLmxheWVyLnByb2plY3QodGhpcy5tZW1vcnkub3V0cHV0TGF5ZXIsIExheWVyLkxheWVyLmNvbm5lY3Rpb25UeXBlLkFMTF9UT19BTEwpO1xuXG4gICAgLy8gc2hpZnRpbmcgbGF5ZXJcbiAgICB0aGlzLnNoaWZ0aW5nTGF5ZXIgPSBuZXcgc29mdG1heExheWVyLlNvZnRNYXhMYXllcih0aGlzLnNoaWZ0TGVuZ3RoLCBcIk5UTTogU2hpZnRpbmcgbGF5ZXJcIik7XG4gICAgdGhpcy5tZW1vcnkuaGlkZGVuTGF5ZXIucHJvamVjdCh0aGlzLnNoaWZ0aW5nTGF5ZXIsIExheWVyLkxheWVyLmNvbm5lY3Rpb25UeXBlLkFMTF9UT19BTEwpO1xuICAgIHRoaXMuc2hpZnRpbmdMYXllci5wcm9qZWN0KHRoaXMubWVtb3J5LmhpZGRlbkxheWVyLCBMYXllci5MYXllci5jb25uZWN0aW9uVHlwZS5BTExfVE9fQUxMKTtcbiAgICB0aGlzLnNfc2hpZnRpbmdWZWN0b3IgPSB0aGlzLnNoaWZ0aW5nTGF5ZXIuY3VycmVudEFjdGl2YXRpb247XG4gIH1cblxuICBwcml2YXRlIHJlYWRQYXJhbXMoYWN0aXZhdGlvbjogU3luYXB0aWMuSU51bWVyaWNBcnJheSkge1xuXG4gICAgdGhpcy7Dn19rZXlTdHJlbmd0aCA9IGFjdGl2YXRpb25bMF07XG4gICAgdGhpcy5nX2ludGVycG9sYXRpb24gPSBhY3RpdmF0aW9uWzFdO1xuICAgIHRoaXMuWV9mb2N1cyA9IGFjdGl2YXRpb25bMl0gKyAxOy8vU3F1YXNoLlNPRlRQTFVTKGFjdGl2YXRpb25bMl0pICsgMTtcblxuICAgIHZhciBzdGFydEF0ID0gMztcbiAgICBmb3IgKHZhciBrID0gMDsgayA8IHRoaXMua19rZXlzLmxlbmd0aDsgaysrKSB7XG4gICAgICB0aGlzLmtfa2V5c1trXSA9IHRoaXMubGF5ZXIubGlzdFtrICsgc3RhcnRBdF0uYWN0aXZhdGlvbjtcbiAgICB9XG5cbiAgICBzdGFydEF0ICs9IHRoaXMua19rZXlzLmxlbmd0aDtcbiAgICBmb3IgKHZhciBrID0gMDsgayA8IHRoaXMuYWRkR2F0ZS5sZW5ndGg7IGsrKykge1xuICAgICAgdGhpcy5hZGRHYXRlW2tdID0gdGhpcy5sYXllci5saXN0W2sgKyBzdGFydEF0XS5hY3RpdmF0aW9uO1xuICAgIH1cblxuICAgIHN0YXJ0QXQgKz0gdGhpcy5hZGRHYXRlLmxlbmd0aDtcbiAgICBmb3IgKHZhciBrID0gMDsgayA8IHRoaXMuZXJhc2VHYXRlLmxlbmd0aDsgaysrKSB7XG4gICAgICB0aGlzLmVyYXNlR2F0ZVtrXSA9IFNxdWFzaC5MT0dJU1RJQyh0aGlzLmxheWVyLmxpc3RbayArIHN0YXJ0QXRdLmFjdGl2YXRpb24pO1xuICAgIH1cblxuICAgIHZhciBNID0gdGhpcy5tZW1vcnkuZGF0YTtcbiAgICBcbiAgICAvLyBmb2N1cyBieSBjb250ZW50LCBvYnRhaW5zIGFuIGFycmF5IG9mIHNpbWlsYXJpdHkgaW5kZXhlcyBmb3IgZWFjaCBtZW1vcnlCbG9ja1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgTS5sZW5ndGg7IGkrKylcbiAgICAgIHRoaXMud2NfZm9jdXNlZFdlaWdodHNbaV0gPSBVdGlscy5nZXRDb3NpbmVTaW1pbGFyaXR5KE1baV0sIHRoaXMua19rZXlzKSAqIHRoaXMuw59fa2V5U3RyZW5ndGg7XG4gICAgXG4gICAgVXRpbHMuc29mdE1heCh0aGlzLndjX2ZvY3VzZWRXZWlnaHRzKTtcbiAgICBcbiAgICAvLyBmb2N1cyBieSBsb2NhdGlvbiAoaW50ZXJwb2xhdGlvbilcbiAgICBVdGlscy5pbnRlcnBvbGF0ZUFycmF5KHRoaXMud2NfZm9jdXNlZFdlaWdodHMsIHRoaXMud193ZWlnaHRpbmdzLCB0aGlzLmdfaW50ZXJwb2xhdGlvbik7XG4gICAgXG4gICAgLy8gY29udm9sdXRpb25hbCBzaGlmdFxuICAgIC8vdGhpcy5kb1NoaWZ0aW5ncygpO1xuICAgIFV0aWxzLnZlY3RvckludmVydGVkU2hpZnRpbmcodGhpcy53Y19mb2N1c2VkV2VpZ2h0cywgdGhpcy5zX3NoaWZ0aW5nVmVjdG9yKTtcbiAgICAgXG4gICAgLy8gc2hhcnBlbmluZ1xuICAgIFV0aWxzLnNoYXJwQXJyYXkodGhpcy53X3dlaWdodGluZ3MsIHRoaXMud2NfZm9jdXNlZFdlaWdodHMsIHRoaXMuWV9mb2N1cyk7XG4gICAgXG4gICAgLy8gc2luY2Ug4oiRIHcgPSAxLCB3ZSBoYXZlIHRvIHNvZnRtYXggdGhlIGFycmF5XG4gICAgVXRpbHMuc29mdE1heCh0aGlzLndfd2VpZ2h0aW5ncyk7XG4gICAgXG4gICAgLy8vIHdlIGdvdCB3dCFcbiAgfVxuXG4gIGRvU2hpZnRpbmdzKCkge1xuICAgIC8vIGNhbGwgdGhpcyBmbiBpbiBjYXNlIG9mIG5vdCB1c2luZyBhIHNvZnRtYXhMYXllciBmb3Igc2hpZnRpbmdcbiAgICBcbiAgICBVdGlscy5zb2Z0TWF4KHRoaXMuc19zaGlmdGluZ1ZlY3Rvcik7XG4gICAgVXRpbHMudmVjdG9ySW52ZXJ0ZWRTaGlmdGluZyh0aGlzLndjX2ZvY3VzZWRXZWlnaHRzLCB0aGlzLnNfc2hpZnRpbmdWZWN0b3IpO1xuICB9XG5cbiAgZG9UaW1lU3RlcCgpIHtcbiAgICB2YXIgYWN0aXZhdGlvbiA9IHRoaXMubGF5ZXIuYWN0aXZhdGUoKTtcbiAgICBcbiAgICB0aGlzLnNoaWZ0aW5nTGF5ZXIgJiYgdGhpcy5zaGlmdGluZ0xheWVyLmFjdGl2YXRlKCk7XG5cbiAgICB0aGlzLnJlYWRQYXJhbXMoYWN0aXZhdGlvbik7XG4gICAgXG4gICAgLy8gcmVhZGluZ1xuICAgIGZvciAodmFyIGluZGV4ID0gMDsgaW5kZXggPCB0aGlzLm1lbW9yeS5ibG9ja3M7IGluZGV4KyspIHtcbiAgICAgIHRoaXMucmVhZFZlY3RvcltpbmRleF0gPSAwO1xuICAgICAgZm9yICh2YXIgY2VsbCA9IDA7IGNlbGwgPCB0aGlzLm1lbW9yeS5ibG9ja1dpZHRoOyBjZWxsKyspIHtcbiAgICAgICAgdGhpcy5yZWFkVmVjdG9yW2luZGV4XSArPSB0aGlzLm1lbW9yeS5kYXRhW2luZGV4XVtjZWxsXSAqIHRoaXMud193ZWlnaHRpbmdzW2luZGV4XTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn0iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=