/* jslint esversion: 6 */

/*
 * Copyright 2019 Abakkk
 *
 * This file is part of DrawOnYourScreen, a drawing extension for GNOME Shell.
 * https://framagit.org/abakkk/DrawOnYourScreen
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const Cairo = imports.cairo;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const PangoCairo = imports.gi.PangoCairo;

const reverseEnumeration = function(obj) {
    let reversed = {};
    Object.keys(obj).forEach(key => {
        reversed[obj[key]] = key.slice(0,1) + key.slice(1).toLowerCase().replace('_', '-');
    });
    return reversed;
};

var Shapes = { NONE: 0, LINE: 1, ELLIPSE: 2, RECTANGLE: 3, TEXT: 4, POLYGON: 5, POLYLINE: 6 };
var Manipulations = { MOVE: 100, RESIZE: 101, MIRROR: 102 };
var Transformations = { TRANSLATION: 0, ROTATION: 1, SCALE_PRESERVE: 2, STRETCH: 3, REFLECTION: 4, INVERSION: 5 };
var LineCapNames = Object.assign(reverseEnumeration(Cairo.LineCap), { 2: 'Square' });
var LineJoinNames = reverseEnumeration(Cairo.LineJoin);
var FillRuleNames = { 0: 'Nonzero', 1: 'Evenodd' };
var FontWeightNames = Object.assign(reverseEnumeration(Pango.Weight), { 200: "Ultra-light", 350: "Semi-light", 600: "Semi-bold", 800: "Ultra-bold" });
delete FontWeightNames[Pango.Weight.ULTRAHEAVY];
var FontStyleNames = reverseEnumeration(Pango.Style);
var FontStretchNames = reverseEnumeration(Pango.Stretch);
var FontVariantNames = reverseEnumeration(Pango.Variant);


const SVG_DEBUG_SUPERPOSES_CAIRO = false;
const RADIAN = 180 / Math.PI;               // degree
const INVERSION_CIRCLE_RADIUS = 12;         // px
const REFLECTION_TOLERANCE = 5;             // px,  to select vertical and horizontal directions
const STRETCH_TOLERANCE = Math.PI / 8;      // rad, to select vertical and horizontal directions
const MIN_REFLECTION_LINE_LENGTH = 10;      // px
const MIN_TRANSLATION_DISTANCE = 1;         // px
const MIN_ROTATION_ANGLE = Math.PI / 1000;  // rad
const MIN_DRAWING_SIZE = 3;                 // px

// DrawingElement represents a "brushstroke".
// It can be converted into a cairo path as well as a svg element.
// See DrawingArea._startDrawing() to know its params.
var DrawingElement = new Lang.Class({
    Name: 'DrawOnYourScreenDrawingElement',
    
    _init: function(params) {
        for (let key in params)
            this[key] = params[key];
        
        // compatibility with json generated by old extension versions
        
        if (params.fillRule === undefined)
            this.fillRule = Cairo.FillRule.WINDING;
        if (params.transformations === undefined)
            this.transformations = [];
        if (params.shape == Shapes.TEXT) {
            if (params.font && params.font.weight === 0)
                this.font.weight = 400;
            if (params.font && params.font.weight === 1)
                this.font.weight = 700;
        }
        
        if (params.transform && params.transform.center) {
            let angle = (params.transform.angle || 0) + (params.transform.startAngle || 0);
            if (angle)
                this.transformations.push({ type: Transformations.ROTATION, angle: angle });
        }
        if (params.shape == Shapes.ELLIPSE && params.transform && params.transform.ratio && params.transform.ratio != 1 && params.points.length >= 2) {
            let [ratio, p0, p1] = [params.transform.ratio, params.points[0], params.points[1]];
            // Add a fake point that will give the right ellipse ratio when building the element.
            this.points.push([ratio * (p1[0] - p0[0]) + p0[0], ratio * (p1[1] - p0[1]) + p0[1]]);
        }
        delete this.transform;
    },
    
    // toJSON is called by JSON.stringify
    toJSON: function() {
        return {
            shape: this.shape,
            color: this.color,
            line: this.line,
            dash: this.dash,
            fill: this.fill,
            fillRule: this.fillRule,
            eraser: this.eraser,
            transformations: this.transformations,
            text: this.text,
            lineIndex: this.lineIndex !== undefined ? this.lineIndex : undefined,
            textRightAligned: this.textRightAligned,
            font: this.font,
            points: this.points.map((point) => [Math.round(point[0]*100)/100, Math.round(point[1]*100)/100])
        };
    },
    
    buildCairo: function(cr, params) {
        let [success, color] = Clutter.Color.from_string(this.color);
        if (success)
            Clutter.cairo_set_source_color(cr, color);
        
        if (this.showSymmetryElement) {
            let transformation = this.lastTransformation;
            setDummyStroke(cr);
            if (transformation.type == Transformations.REFLECTION) {
                cr.moveTo(transformation.startX, transformation.startY);
                cr.lineTo(transformation.endX, transformation.endY);
            } else {
                cr.arc(transformation.endX, transformation.endY, INVERSION_CIRCLE_RADIUS, 0, 2 * Math.PI);
            }
            cr.stroke();
        }
        
        cr.setLineCap(this.line.lineCap);
        cr.setLineJoin(this.line.lineJoin);
        cr.setLineWidth(this.line.lineWidth);
        if (this.fillRule)
            cr.setFillRule(this.fillRule);
        
        if (this.dash && this.dash.active && this.dash.array && this.dash.array[0] && this.dash.array[1])
            cr.setDash(this.dash.array, this.dash.offset);
        
        if (this.eraser)
            cr.setOperator(Cairo.Operator.CLEAR);
        else
            cr.setOperator(Cairo.Operator.OVER);
        
        if (params.dummyStroke)
            setDummyStroke(cr);
        
        if (SVG_DEBUG_SUPERPOSES_CAIRO) {
            Clutter.cairo_set_source_color(cr, Clutter.Color.new(255, 0, 0, 255));
            cr.setLineWidth(this.line.lineWidth / 2 || 1);
        }
        
        this.transformations.slice(0).reverse().forEach(transformation => {
            if (transformation.type == Transformations.TRANSLATION) {
                cr.translate(transformation.slideX, transformation.slideY);
            } else if (transformation.type == Transformations.ROTATION) {
                let center = this._getTransformedCenter(transformation);
                cr.translate(center[0], center[1]);
                cr.rotate(transformation.angle);
                cr.translate(-center[0], -center[1]);
            } else if (transformation.type == Transformations.SCALE_PRESERVE || transformation.type == Transformations.STRETCH) {
                let center = this._getTransformedCenter(transformation);
                cr.translate(center[0], center[1]);
                cr.rotate(transformation.angle);
                cr.scale(transformation.scaleX, transformation.scaleY);
                cr.rotate(-transformation.angle);
                cr.translate(-center[0], -center[1]);
            } else if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION) {
                cr.translate(transformation.slideX, transformation.slideY);
                cr.rotate(transformation.angle);
                cr.scale(transformation.scaleX, transformation.scaleY);
                cr.rotate(-transformation.angle);
                cr.translate(-transformation.slideX, -transformation.slideY);
            }
        });
        
        let [points, shape] = [this.points, this.shape];
        
        if (shape == Shapes.LINE && points.length == 3) {
            cr.moveTo(points[0][0], points[0][1]);
            cr.curveTo(points[0][0], points[0][1], points[1][0], points[1][1], points[2][0], points[2][1]);
            
        } else if (shape == Shapes.LINE && points.length == 4) {
            cr.moveTo(points[0][0], points[0][1]);
            cr.curveTo(points[1][0], points[1][1], points[2][0], points[2][1], points[3][0], points[3][1]);
            
        } else if (shape == Shapes.NONE || shape == Shapes.LINE) {
            cr.moveTo(points[0][0], points[0][1]);
            for (let j = 1; j < points.length; j++) {
                cr.lineTo(points[j][0], points[j][1]);
            }
            
        } else if (shape == Shapes.ELLIPSE && points.length >= 2) {
            let radius = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
            let ratio = 1;
            
            if (points[2]) {
                ratio = Math.hypot(points[2][0] - points[0][0], points[2][1] - points[0][1]) / radius;
                cr.translate(points[0][0], points[0][1]);
                cr.scale(ratio, 1);
                cr.translate(-points[0][0], -points[0][1]);
                cr.arc(points[0][0], points[0][1], radius, 0, 2 * Math.PI);
                cr.translate(points[0][0], points[0][1]);
                cr.scale(1 / ratio, 1);
                cr.translate(-points[0][0], -points[0][1]);
            } else
                cr.arc(points[0][0], points[0][1], radius, 0, 2 * Math.PI);
            
        } else if (shape == Shapes.RECTANGLE && points.length == 2) {
            cr.rectangle(points[0][0], points[0][1], points[1][0] - points[0][0], points[1][1] - points[0][1]);
        
        } else if ((shape == Shapes.POLYGON || shape == Shapes.POLYLINE) && points.length >= 2) {
            cr.moveTo(points[0][0], points[0][1]);
            for (let j = 1; j < points.length; j++) {
                cr.lineTo(points[j][0], points[j][1]);
            }
            if (shape == Shapes.POLYGON)
                cr.closePath();
            
        } else if (shape == Shapes.TEXT && points.length == 2) {
            let layout = PangoCairo.create_layout(cr);
            let fontSize = Math.abs(points[1][1] - points[0][1]) * Pango.SCALE;
            let fontDescription = new Pango.FontDescription();
            fontDescription.set_absolute_size(fontSize);
            ['family', 'weight', 'style', 'stretch', 'variant'].forEach(attribute => {
                if (this.font[attribute] !== undefined)
                    try {
                        fontDescription[`set_${attribute}`](this.font[attribute]);
                    } catch(e) {}
            });
            layout.set_font_description(fontDescription);
            layout.set_text(this.text, -1);
            this.textWidth = layout.get_pixel_size()[0];
            cr.moveTo(points[1][0] - (this.textRightAligned ? this.textWidth : 0), Math.max(points[0][1],points[1][1]) - layout.get_baseline() / Pango.SCALE);
            layout.set_text(this.text, -1);
            PangoCairo.show_layout(cr, layout);
            
            if (params.showTextCursor) {
                let cursorPosition = this.cursorPosition == -1 ? this.text.length : this.cursorPosition;
                layout.set_text(this.text.slice(0, cursorPosition), -1);
                let width = layout.get_pixel_size()[0];
                cr.rectangle(points[1][0] - (this.textRightAligned ? this.textWidth : 0) + width, Math.max(points[0][1],points[1][1]),
                             Math.abs(points[1][1] - points[0][1]) / 25, - Math.abs(points[1][1] - points[0][1]));
                cr.fill();
            }
            
            if (params.showTextRectangle || params.drawTextRectangle) {
                cr.rectangle(points[1][0] - (this.textRightAligned ? this.textWidth : 0), Math.max(points[0][1], points[1][1]),
                             this.textWidth, - Math.abs(points[1][1] - points[0][1]));
                if (params.showTextRectangle)
                    setDummyStroke(cr);
                else
                    // Only draw the rectangle to find the element, not to show it.
                    cr.setLineWidth(0);
            }
        }
        
        cr.identityMatrix();
    },
    
    getContainsPoint: function(cr, x, y) {
        if (this.shape == Shapes.TEXT)
            return cr.inFill(x, y);
        
        cr.save();
        cr.setLineWidth(Math.max(this.line.lineWidth, 25));
        cr.setDash([], 0);
        
        // Check whether the point is inside/on/near the element.
        let inElement = cr.inStroke(x, y) || this.fill && cr.inFill(x, y);
        cr.restore();
        return inElement;
    },
    
    buildSVG: function(bgColor) {
        let row = "\n  ";
        let points = this.points.map((point) => [Math.round(point[0]*100)/100, Math.round(point[1]*100)/100]);
        let color = this.eraser ? bgColor : this.color;
        let fill = this.fill && !this.isStraightLine;
        let attributes = '';
        
        if (fill) {
            attributes = `fill="${color}"`;
            if (this.fillRule)
                attributes += ` fill-rule="${FillRuleNames[this.fillRule].toLowerCase()}"`;
        } else {
            attributes = `fill="none"`;
        }
        
        if (this.line && this.line.lineWidth) {
            attributes += ` stroke="${color}"` +
                          ` stroke-width="${this.line.lineWidth}"`;
            if (this.line.lineCap)
                attributes += ` stroke-linecap="${LineCapNames[this.line.lineCap].toLowerCase()}"`;
            if (this.line.lineJoin && !this.isStraightLine)
                attributes += ` stroke-linejoin="${LineJoinNames[this.line.lineJoin].toLowerCase()}"`;
            if (this.dash && this.dash.active && this.dash.array && this.dash.array[0] && this.dash.array[1])
                attributes += ` stroke-dasharray="${this.dash.array[0]} ${this.dash.array[1]}" stroke-dashoffset="${this.dash.offset}"`;
        } else {
            attributes += ` stroke="none"`;
        }
        
        let transAttribute = '';
        this.transformations.slice(0).reverse().forEach(transformation => {
            transAttribute += transAttribute ? ' ' : ' transform="';
            let center = this._getTransformedCenter(transformation);
            
            if (transformation.type == Transformations.TRANSLATION) {
                transAttribute += `translate(${transformation.slideX},${transformation.slideY})`;
            } else if (transformation.type == Transformations.ROTATION) {
                transAttribute += `translate(${center[0]},${center[1]}) `;
                transAttribute += `rotate(${transformation.angle * RADIAN}) `;
                transAttribute += `translate(${-center[0]},${-center[1]})`;
            } else if (transformation.type == Transformations.SCALE_PRESERVE || transformation.type == Transformations.STRETCH) {
                transAttribute += `translate(${center[0]},${center[1]}) `;
                transAttribute += `rotate(${transformation.angle * RADIAN}) `;
                transAttribute += `scale(${transformation.scaleX},${transformation.scaleY}) `;
                transAttribute += `rotate(${-transformation.angle * RADIAN}) `;
                transAttribute += `translate(${-center[0]},${-center[1]})`;
            } else if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION) {
                transAttribute += `translate(${transformation.slideX}, ${transformation.slideY}) `;
                transAttribute += `rotate(${transformation.angle * RADIAN}) `;
                transAttribute += `scale(${transformation.scaleX}, ${transformation.scaleY}) `;
                transAttribute += `rotate(${-transformation.angle * RADIAN}) `;
                transAttribute += `translate(${-transformation.slideX}, ${-transformation.slideY})`;
            }
        });
        transAttribute += transAttribute ? '"' : '';
        
        if (this.shape == Shapes.LINE && points.length == 4) {
            row += `<path ${attributes} d="M${points[0][0]} ${points[0][1]}`;
            row += ` C ${points[1][0]} ${points[1][1]}, ${points[2][0]} ${points[2][1]}, ${points[3][0]} ${points[3][1]}`;
            row += `${fill ? 'z' : ''}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.LINE && points.length == 3) {
            row += `<path ${attributes} d="M${points[0][0]} ${points[0][1]}`;
            row += ` C ${points[0][0]} ${points[0][1]}, ${points[1][0]} ${points[1][1]}, ${points[2][0]} ${points[2][1]}`;
            row += `${fill ? 'z' : ''}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.LINE) {
            row += `<line ${attributes} x1="${points[0][0]}" y1="${points[0][1]}" x2="${points[1][0]}" y2="${points[1][1]}"${transAttribute}/>`;
        
        } else if (this.shape == Shapes.NONE) {
            row += `<path ${attributes} d="M${points[0][0]} ${points[0][1]}`;
            for (let i = 1; i < points.length; i++)
                row += ` L ${points[i][0]} ${points[i][1]}`;
            row += `${fill ? 'z' : ''}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.ELLIPSE && points.length == 3) {
            let ry = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
            let rx = Math.hypot(points[2][0] - points[0][0], points[2][1] - points[0][1]);
            row += `<ellipse ${attributes} cx="${points[0][0]}" cy="${points[0][1]}" rx="${rx}" ry="${ry}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.ELLIPSE && points.length == 2) {
            let r = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
            row += `<circle ${attributes} cx="${points[0][0]}" cy="${points[0][1]}" r="${r}"${transAttribute}/>`;
            
        } else if (this.shape == Shapes.RECTANGLE && points.length == 2) {
            row += `<rect ${attributes} x="${Math.min(points[0][0], points[1][0])}" y="${Math.min(points[0][1], points[1][1])}" ` +
                   `width="${Math.abs(points[1][0] - points[0][0])}" height="${Math.abs(points[1][1] - points[0][1])}"${transAttribute}/>`;
                   
        } else if (this.shape == Shapes.POLYGON && points.length >= 3) {
            row += `<polygon ${attributes} points="`;
            for (let i = 0; i < points.length; i++)
                row += ` ${points[i][0]},${points[i][1]}`;
            row += `"${transAttribute}/>`;
        
        } else if (this.shape == Shapes.POLYLINE && points.length >= 2) {
            row += `<polyline ${attributes} points="`;
            for (let i = 0; i < points.length; i++)
                row += ` ${points[i][0]},${points[i][1]}`;
            row += `"${transAttribute}/>`;
        
        } else if (this.shape == Shapes.TEXT && points.length == 2) {
            attributes = `fill="${color}" ` +
                         `stroke="transparent" ` +
                         `stroke-opacity="0" ` +
                         `font-size="${Math.abs(points[1][1] - points[0][1])}"`;
            
            if (this.font.family)
                attributes += ` font-family="${this.font.family}"`;
            if (this.font.weight && this.font.weight != Pango.Weight.NORMAL)
                attributes += ` font-weight="${this.font.weight}"`;
            if (this.font.style && FontStyleNames[this.font.style])
                attributes += ` font-style="${FontStyleNames[this.font.style].toLowerCase()}"`;
            if (FontStretchNames[this.font.stretch] && this.font.stretch != Pango.Stretch.NORMAL)
                attributes += ` font-stretch="${FontStretchNames[this.font.stretch].toLowerCase()}"`;
            if (this.font.variant && FontVariantNames[this.font.variant])
                attributes += ` font-variant="${FontVariantNames[this.font.variant].toLowerCase()}"`;
            
            // this.textWidth is computed during Cairo building.
            row += `<text ${attributes} x="${points[1][0] - (this.textRightAligned ? this.textWidth : 0)}" `;
            row += `y="${Math.max(points[0][1], points[1][1])}"${transAttribute}>${this.text}</text>`;
        }
        
        return row;
    },
    
    get lastTransformation() {
        if (!this.transformations.length)
            return null;
        
        return this.transformations[this.transformations.length - 1];
    },
    
    get isStraightLine() {
        return this.shape == Shapes.LINE && this.points.length == 2;
    },
    
    smoothAll: function() {
        for (let i = 0; i < this.points.length; i++) {
            this._smooth(i);
        }
    },
    
    addPoint: function() {
        if (this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE) {
            // copy last point
            let [lastPoint, secondToLastPoint] = [this.points[this.points.length - 1], this.points[this.points.length - 2]];
            if (!getNearness(secondToLastPoint, lastPoint, MIN_DRAWING_SIZE))
                this.points.push([lastPoint[0], lastPoint[1]]);
        } else if (this.shape == Shapes.LINE) {
            if (this.points.length == 2) {
                this.points[2] = this.points[1];
            } else if (this.points.length == 3) {
                this.points[3] = this.points[2];
                this.points[2] = this.points[1];
            }
        }
    },
    
    startDrawing: function(startX, startY) {
        this.points.push([startX, startY]);
        
        if (this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE)
            this.points.push([startX, startY]);
    },
    
    updateDrawing: function(x, y, transform) {
        let points = this.points;
        if (x == points[points.length - 1][0] && y == points[points.length - 1][1])
            return;
        
        transform = transform || this.transformations.length >= 1;
        
        if (this.shape == Shapes.NONE) {
            points.push([x, y]);
            if (transform)
                this._smooth(points.length - 1);
            
        } else if ((this.shape == Shapes.RECTANGLE || this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE) && transform) {
            if (points.length < 2)
                return;
                
            let center = this._getOriginalCenter();
            this.transformations[0] = { type: Transformations.ROTATION,
                                        angle: getAngle(center[0], center[1], points[points.length - 1][0], points[points.length - 1][1], x, y) };
            
        } else if (this.shape == Shapes.ELLIPSE && transform) {
            if (points.length < 2)
                return;
            
            points[2] = [x, y];
            let center = this._getOriginalCenter();
            this.transformations[0] = { type: Transformations.ROTATION,
                                        angle: getAngle(center[0], center[1], center[0] + 1, center[1], x, y) };
            
        } else if (this.shape == Shapes.POLYGON || this.shape == Shapes.POLYLINE) {
            points[points.length - 1] = [x, y];
            
        } else if (this.shape == Shapes.TEXT && transform) {
           if (points.length < 2)
                return;
        
            let [slideX, slideY] = [x - points[1][0], y - points[1][1]];
            points[0] = [points[0][0] + slideX, points[0][1] + slideY];
            points[1] = [x, y];
        
        } else {
            points[1] = [x, y];
            
        }
    },
    
    stopDrawing: function() {
        // skip when the size is too small to be visible (3px) (except for free drawing)
        if (this.shape != Shapes.NONE && this.points.length >= 2) {
            let lastPoint = this.points[this.points.length - 1];
            let secondToLastPoint = this.points[this.points.length - 2];
            if (getNearness(secondToLastPoint, lastPoint, MIN_DRAWING_SIZE))
                this.points.pop();
        }
        
        if (this.transformations[0] && this.transformations[0].type == Transformations.ROTATION &&
                Math.abs(this.transformations[0].angle) < MIN_ROTATION_ANGLE)
            this.transformations.shift();
    },
    
    startTransformation: function(startX, startY, type) {
        if (type == Transformations.TRANSLATION)
            this.transformations.push({ startX: startX, startY: startY, type: type, slideX: 0, slideY: 0 });
        else if (type == Transformations.ROTATION)
            this.transformations.push({ startX: startX, startY: startY, type: type, angle: 0 });
        else if (type == Transformations.SCALE_PRESERVE || type == Transformations.STRETCH)
            this.transformations.push({ startX: startX, startY: startY, type: type, scaleX: 1, scaleY: 1, angle: 0 });
        else if (type == Transformations.REFLECTION)
            this.transformations.push({ startX: startX, startY: startY, endX: startX, endY: startY, type: type,
                                        scaleX:  1, scaleY:  1, slideX: 0, slideY: 0, angle: 0 });
        else if (type == Transformations.INVERSION)
            this.transformations.push({ startX: startX, startY: startY, endX: startX, endY: startY, type: type,
                                        scaleX: -1, scaleY: -1, slideX: startX, slideY: startY,
                                        angle: Math.PI + Math.atan(startY / (startX || 1)) });
        
        if (type == Transformations.REFLECTION || type == Transformations.INVERSION)
            this.showSymmetryElement = true;
    },
    
    updateTransformation: function(x, y) {
        let transformation = this.lastTransformation;
        
        if (transformation.type == Transformations.TRANSLATION) {
            transformation.slideX = x - transformation.startX;
            transformation.slideY = y - transformation.startY;
        } else if (transformation.type == Transformations.ROTATION) {
            let center = this._getTransformedCenter(transformation);
            transformation.angle = getAngle(center[0], center[1], transformation.startX, transformation.startY, x, y);
        } else if (transformation.type == Transformations.SCALE_PRESERVE) {
            let center = this._getTransformedCenter(transformation);
            let scale = Math.hypot(x - center[0], y - center[1]) / Math.hypot(transformation.startX - center[0], transformation.startY - center[1]) || 1;
            [transformation.scaleX, transformation.scaleY] = [scale, scale];
        } else if (transformation.type == Transformations.STRETCH) {
            let center = this._getTransformedCenter(transformation);
            let startAngle = getAngle(center[0], center[1], center[0] + 1, center[1], transformation.startX, transformation.startY);
            let vertical = Math.abs(Math.sin(startAngle)) >= Math.sin(Math.PI / 2 - STRETCH_TOLERANCE);
            let horizontal = Math.abs(Math.cos(startAngle)) >= Math.cos(STRETCH_TOLERANCE);
            let scale = Math.hypot(x - center[0], y - center[1]) / Math.hypot(transformation.startX - center[0], transformation.startY - center[1]) || 1;
            transformation.scaleX = vertical ? 1 : scale;
            transformation.scaleY = !vertical ? 1 : scale;
            transformation.angle = vertical || horizontal ? 0 : getAngle(center[0], center[1], center[0] + 1, center[1], x, y);
        } else if (transformation.type == Transformations.REFLECTION) {
            [transformation.endX, transformation.endY] = [x, y];
            if (getNearness([transformation.startX, transformation.startY], [x, y], MIN_REFLECTION_LINE_LENGTH)) {
                // do nothing to avoid jumps (no transformation at starting and locked transformation after)
            } else if (Math.abs(y - transformation.startY) <= REFLECTION_TOLERANCE && Math.abs(x - transformation.startX) > REFLECTION_TOLERANCE) {
                [transformation.scaleX, transformation.scaleY] = [1, -1];
                [transformation.slideX, transformation.slideY] = [0, transformation.startY];
                transformation.angle = Math.PI;
            } else if (Math.abs(x - transformation.startX) <= REFLECTION_TOLERANCE && Math.abs(y - transformation.startY) > REFLECTION_TOLERANCE) {
                [transformation.scaleX, transformation.scaleY] = [-1, 1];
                [transformation.slideX, transformation.slideY] = [transformation.startX, 0];
                transformation.angle = Math.PI;
            } else if (x != transformation.startX) {
                let tan = (y - transformation.startY) / (x - transformation.startX);
                [transformation.scaleX, transformation.scaleY] = [1, -1];
                [transformation.slideX, transformation.slideY] = [0, transformation.startY - transformation.startX * tan];
                transformation.angle = Math.PI + Math.atan(tan);
            } else if (y != transformation.startY) {
                let tan = (x - transformation.startX) / (y - transformation.startY);
                [transformation.scaleX, transformation.scaleY] = [-1, 1];
                [transformation.slideX, transformation.slideY] = [transformation.startX - transformation.startY * tan, 0];
                transformation.angle = Math.PI - Math.atan(tan);
            }
        } else if (transformation.type == Transformations.INVERSION) {
            [transformation.endX, transformation.endY] = [x, y];
            [transformation.scaleX, transformation.scaleY] = [-1, -1];
            [transformation.slideX, transformation.slideY] = [x, y];
            transformation.angle = Math.PI + Math.atan(y / (x || 1));
        }
    },
    
    stopTransformation: function() {
        // Clean transformations
        let transformation = this.lastTransformation;
        
        if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION)
            this.showSymmetryElement = false;
        
        if (transformation.type == Transformations.REFLECTION &&
                getNearness([transformation.startX, transformation.startY], [transformation.endX, transformation.endY], MIN_REFLECTION_LINE_LENGTH) ||
            transformation.type == Transformations.TRANSLATION && Math.hypot(transformation.slideX, transformation.slideY) < MIN_TRANSLATION_DISTANCE ||
            transformation.type == Transformations.ROTATION && Math.abs(transformation.angle) < MIN_ROTATION_ANGLE) {
            
            this.transformations.pop();
        } else {
            delete transformation.startX;
            delete transformation.startY;
            delete transformation.endX;
            delete transformation.endY;
        }
    },
    
    // When rotating grouped lines, lineOffset is used to retrieve the rotation center of the first line.
    _getLineOffset: function() {
        return (this.lineIndex || 0) * Math.abs(this.points[1][1] - this.points[0][1]);
    },
    
    // The figure rotation center before transformations (original).
    // this.textWidth is computed during Cairo building.
    _getOriginalCenter: function() {
        if (!this._originalCenter) {
            let points = this.points;
            this._originalCenter = this.shape == Shapes.ELLIPSE ? [points[0][0], points[0][1]] :
                                   this.shape == Shapes.LINE && points.length == 4 ? getCurveCenter(points[0], points[1], points[2], points[3]) :
                                   this.shape == Shapes.LINE && points.length == 3 ? getCurveCenter(points[0], points[0], points[1], points[2]) :
                                   this.shape == Shapes.TEXT && this.textWidth ? [points[1][0], Math.max(points[0][1], points[1][1]) - this._getLineOffset()] :
                                   points.length >= 3 ? getCentroid(points) :
                                   getNaiveCenter(points);
        }
        
        return this._originalCenter;
    },
    
    // The figure rotation center, whose position is affected by all transformations done before 'transformation'.
    _getTransformedCenter: function(transformation) {
        if (!transformation.elementTransformedCenter) {
            let matrix = new Pango.Matrix({ xx: 1, xy: 0, yx: 0, yy: 1, x0: 0, y0: 0 });
            
            // Apply transformations to the matrice in reverse order
            // because Pango multiply matrices by the left when applying a transformation
            this.transformations.slice(0, this.transformations.indexOf(transformation)).reverse().forEach(transformation => {
                if (transformation.type == Transformations.TRANSLATION) {
                    matrix.translate(transformation.slideX, transformation.slideY);
                } else if (transformation.type == Transformations.ROTATION) {
                    // nothing, the center position is preserved.
                } else if (transformation.type == Transformations.SCALE_PRESERVE || transformation.type == Transformations.STRETCH) {
                    // nothing, the center position is preserved.
                } else if (transformation.type == Transformations.REFLECTION || transformation.type == Transformations.INVERSION) {
                    matrix.translate(transformation.slideX, transformation.slideY);
                    matrix.rotate(-transformation.angle * RADIAN);
                    matrix.scale(transformation.scaleX, transformation.scaleY);
                    matrix.rotate(transformation.angle * RADIAN);
                    matrix.translate(-transformation.slideX, -transformation.slideY);
                }
            });
            
            let originalCenter = this._getOriginalCenter();
            transformation.elementTransformedCenter = matrix.transform_point(originalCenter[0], originalCenter[1]);
        }
        
        return transformation.elementTransformedCenter;
    },
    
    _smooth: function(i) {
        if (i < 2)
            return;
        this.points[i-1] = [(this.points[i-2][0] + this.points[i][0]) / 2, (this.points[i-2][1] + this.points[i][1]) / 2];
    }
});

const setDummyStroke = function(cr) {
    cr.setLineWidth(2);
    cr.setLineCap(0);
    cr.setLineJoin(0);
    cr.setDash([1, 2], 0);
};

/*
    Some geometric utils
*/

const getNearness = function(pointA, pointB, distance) {
    return Math.hypot(pointB[0] - pointA[0], pointB[1] - pointA[1]) < distance;
};

// mean of the vertices, ok for regular polygons
const getNaiveCenter = function(points) {
    return points.reduce((accumulator, point) => accumulator = [accumulator[0] + point[0], accumulator[1] + point[1]])
                 .map(coord => coord / points.length);
};

// https://en.wikipedia.org/wiki/Centroid#Of_a_polygon
const getCentroid = function(points) {
    let n = points.length;
    points.push(points[0]);
    
    let [sA, sX, sY] = [0, 0, 0];
    for (let i = 0; i <= n-1; i++) {
        let a = points[i][0]*points[i+1][1] - points[i+1][0]*points[i][1];
        sA += a;
        sX += (points[i][0] + points[i+1][0]) * a;
        sY += (points[i][1] + points[i+1][1]) * a;
    }
    
    points.pop();
    if (sA == 0)
        return getNaiveCenter(points);
    return [sX / (3 * sA), sY / (3 * sA)];
};

/*
Cubic Bézier:
[0, 1] -> ℝ², P(t) = (1-t)³P₀ + 3t(1-t)²P₁ + 3t²(1-t)P₂ + t³P₃

general case:

const cubicBezierCoord = function(x0, x1, x2, x3, t) {
    return (1-t)**3*x0 + 3*t*(1-t)**2*x1 + 3*t**2*(1-t)*x2 + t**3*x3;
}

const cubicBezierPoint = function(p0, p1, p2, p3, t) {
    return [cubicBezier(p0[0], p1[0], p2[0], p3[0], t), cubicBezier(p0[1], p1[1], p2[1], p3[1], t)];
}

Approximatively: 
control point: p0 ----  p1  ----  p2  ----  p3  (p2 is not on the curve)
            t: 0  ---- 1/3  ---- 2/3  ----  1
*/

// If the curve has a symmetry axis, it is truly a center (the intersection of the curve and the axis).
// In other cases, it is not a notable point, just a visual approximation.
const getCurveCenter = function(p0, p1, p2, p3) {
    if (p0[0] == p1[0] && p0[1] == p1[1])
        // p0 = p1, t = 2/3
        return [(p1[0] + 6*p1[0] + 12*p2[0] + 8*p3[0]) / 27, (p1[1] + 6*p1[1] + 12*p2[1] + 8*p3[1]) / 27];
    else
        // t = 1/2
        return [(p0[0] + 3*p1[0] + 3*p2[0] + p3[0]) / 8, (p0[1] + 3*p1[1] + 3*p2[1] + p3[1]) / 8];
};

const getAngle = function(xO, yO, xA, yA, xB, yB) {
    // calculate angle of rotation in absolute value
    // cos(AOB) = (OA.OB)/(||OA||*||OB||) where OA.OB = (xA-xO)*(xB-xO) + (yA-yO)*(yB-yO)
    let cos = ((xA - xO)*(xB - xO) + (yA - yO)*(yB - yO)) / (Math.hypot(xA - xO, yA - yO) * Math.hypot(xB - xO, yB - yO));
    
    // acos is defined on [-1, 1] but
    // with A == B and imperfect computer calculations, cos may be equal to 1.00000001.
    cos = Math.min(Math.max(-1, cos), 1);
    let angle = Math.acos( cos );
    
    // determine the sign of the angle
    if (xA == xO) {
        if (xB > xO)
            angle = -angle;
    } else {
        // equation of OA: y = ax + b
        let a = (yA - yO) / (xA - xO);
        let b = yA - a*xA;
        if (yB < a*xB + b)
            angle = - angle;
        if (xA < xO)
            angle = - angle;
    }
    
    return angle;
};

