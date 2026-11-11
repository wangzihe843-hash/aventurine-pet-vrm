/**
 * 屏幕空间自适应描边 —— vendored 自 three.js r171 `examples/jsm/effects/OutlineEffect.js`
 * （仅本地复制并做最小改动；three r172 已删除 MMD addon，本项目 pin 0.171.0）。
 *
 * 相对上游 r171 的改动（PLAN §19.11「描边方案 B」）：
 * 1. `outlineThickness` 语义从「NDC 单位」改为「**CSS 像素**」；
 * 2. 顶点着色器 `calculateOutline` 改为**像素空间归一化**：先把法线方向投影到 CSS 像素空间
 *    归一化，再把目标像素宽换算回 clip 空间 —— 任意分辨率/窗口宽高比/模型缩放下
 *    横向与竖向描边都保持相同像素宽度（上游在 NDC 空间 normalize，16:9 下横边约 2 倍粗）；
 * 3. 新增 `outlineViewport` uniform（CSS 像素视口）与 `setViewportSize(width,height)`
 *    方法，由 `PetScene.setViewport()` 在窗口尺寸变化时写入；
 * 4. 默认厚度 0.003 → 1.0（像素）；颜色/透明度/材质缓存/双 pass 等其余逻辑保持不变。
 *
 * 说明：上游是未带类型的 JS，本文件用 `@ts-nocheck` 保持逐字节结构、避免类型改写引入
 * 行为差异；对外 API 与上游一致（constructor/render/renderOutline/setSize + 新
 * setViewportSize），调用方只有 `scene/pet-scene.ts`。
 */
// @ts-nocheck

import {
	BackSide,
	Color,
	ShaderMaterial,
	UniformsLib,
	UniformsUtils,
	Vector2
} from 'three';

/**
 * Reference: https://en.wikipedia.org/wiki/Cel_shading
 *
 * API
 *
 * 1. Traditional
 *
 * const effect = new OutlineEffect( renderer );
 *
 * function render() {
 *
 * 	effect.render( scene, camera );
 *
 * }
 *
 * 2. VR compatible
 *
 * const effect = new OutlineEffect( renderer );
 * let renderingOutline = false;
 *
 * scene.onAfterRender = function () {
 *
 * 	if ( renderingOutline ) return;
 *
 * 	renderingOutline = true;
 *
 * 	effect.renderOutline( scene, camera );
 *
 * 	renderingOutline = false;
 *
 * };
 *
 * function render() {
 *
 * 	renderer.render( scene, camera );
 *
 * }
 *
 * // How to set default outline parameters
 * new OutlineEffect( renderer, {
 * 	defaultThickness: 0.01,
 * 	defaultColor: [ 0, 0, 0 ],
 * 	defaultAlpha: 0.8,
 * 	defaultKeepAlive: true // keeps outline material in cache even if material is removed from scene
 * } );
 *
 * // How to set outline parameters for each material
 * material.userData.outlineParameters = {
 * 	thickness: 0.01,
 * 	color: [ 0, 0, 0 ],
 * 	alpha: 0.8,
 * 	visible: true,
 * 	keepAlive: true
 * };
 */

class OutlineEffect {

	constructor( renderer, parameters = {} ) {

		this.enabled = true;

		const defaultThickness = parameters.defaultThickness !== undefined ? parameters.defaultThickness : 1.0; // CSS 像素
		const defaultColor = new Color().fromArray( parameters.defaultColor !== undefined ? parameters.defaultColor : [ 0, 0, 0 ] );
		const defaultAlpha = parameters.defaultAlpha !== undefined ? parameters.defaultAlpha : 1.0;
		const defaultKeepAlive = parameters.defaultKeepAlive !== undefined ? parameters.defaultKeepAlive : false;

		// object.material.uuid -> outlineMaterial or
		// object.material[ n ].uuid -> outlineMaterial
		// save at the outline material creation and release
		// if it's unused removeThresholdCount frames
		// unless keepAlive is true.
		const cache = {};

		const removeThresholdCount = 60;

		// outlineMaterial.uuid -> object.material or
		// outlineMaterial.uuid -> object.material[ n ]
		// save before render and release after render.
		const originalMaterials = {};

		// object.uuid -> originalOnBeforeRender
		// save before render and release after render.
		const originalOnBeforeRenders = {};

		//this.cache = cache;  // for debug

		const uniformsOutline = {
			outlineThickness: { value: defaultThickness },
			outlineColor: { value: defaultColor },
			outlineAlpha: { value: defaultAlpha },
			// 屏幕空间描边：视口 CSS 像素尺寸（setViewportSize 写入，updateUniforms 每帧同步）
			outlineViewport: { value: new Vector2( 1, 1 ) }
		};

		// 屏幕空间描边视口（CSS 像素）；轮廓材质按该尺寸把「目标像素宽度」换算成 clip 偏移
		let viewportWidth = 1;
		let viewportHeight = 1;

		const vertexShader = [
			'#include <common>',
			'#include <uv_pars_vertex>',
			'#include <displacementmap_pars_vertex>',
			'#include <fog_pars_vertex>',
			'#include <morphtarget_pars_vertex>',
			'#include <skinning_pars_vertex>',
			'#include <logdepthbuf_pars_vertex>',
			'#include <clipping_planes_pars_vertex>',

			'uniform float outlineThickness;', // 目标描边宽度（CSS 像素）
			'uniform vec2 outlineViewport;', // 视口尺寸（CSS 像素，由 setViewportSize 写入）

			'vec4 calculateOutline( vec4 pos, vec3 normal, vec4 skinned ) {',
			'	vec4 pos2 = projectionMatrix * modelViewMatrix * vec4( skinned.xyz + normal, 1.0 );',
			'	vec2 ndc = pos.xy / pos.w;',
			'	vec2 ndc2 = pos2.xy / pos2.w;',
			// 像素空间归一化：横竖方向得到相同的像素宽度（上游 NDC normalize 在 16:9 下横边约 2 倍粗）
			'	vec2 dirPx = normalize( ( ndc - ndc2 ) * outlineViewport * 0.5 );',
			'	vec2 offsetNdc = dirPx * outlineThickness * 2.0 / outlineViewport;',
			'	return vec4( pos.xy + offsetNdc * pos.w, pos.z, pos.w );',
			'}',

			'void main() {',

			'	#include <uv_vertex>',

			'	#include <beginnormal_vertex>',
			'	#include <morphnormal_vertex>',
			'	#include <skinbase_vertex>',
			'	#include <skinnormal_vertex>',

			'	#include <begin_vertex>',
			'	#include <morphtarget_vertex>',
			'	#include <skinning_vertex>',
			'	#include <displacementmap_vertex>',
			'	#include <project_vertex>',

			'	vec3 outlineNormal = - objectNormal;', // the outline material is always rendered with BackSide

			'	gl_Position = calculateOutline( gl_Position, outlineNormal, vec4( transformed, 1.0 ) );',

			'	#include <logdepthbuf_vertex>',
			'	#include <clipping_planes_vertex>',
			'	#include <fog_vertex>',

			'}',

		].join( '\n' );

		const fragmentShader = [

			'#include <common>',
			'#include <fog_pars_fragment>',
			'#include <logdepthbuf_pars_fragment>',
			'#include <clipping_planes_pars_fragment>',

			'uniform vec3 outlineColor;',
			'uniform float outlineAlpha;',

			'void main() {',

			'	#include <clipping_planes_fragment>',
			'	#include <logdepthbuf_fragment>',

			'	gl_FragColor = vec4( outlineColor, outlineAlpha );',

			'	#include <tonemapping_fragment>',
			'	#include <colorspace_fragment>',
			'	#include <fog_fragment>',
			'	#include <premultiplied_alpha_fragment>',

			'}'

		].join( '\n' );

		function createMaterial() {

			return new ShaderMaterial( {
				type: 'OutlineEffect',
				uniforms: UniformsUtils.merge( [
					UniformsLib[ 'fog' ],
					UniformsLib[ 'displacementmap' ],
					uniformsOutline
				] ),
				vertexShader: vertexShader,
				fragmentShader: fragmentShader,
				side: BackSide
			} );

		}

		function getOutlineMaterialFromCache( originalMaterial ) {

			let data = cache[ originalMaterial.uuid ];

			if ( data === undefined ) {

				data = {
					material: createMaterial(),
					used: true,
					keepAlive: defaultKeepAlive,
					count: 0
				};

				cache[ originalMaterial.uuid ] = data;

			}

			data.used = true;

			return data.material;

		}

		function getOutlineMaterial( originalMaterial ) {

			const outlineMaterial = getOutlineMaterialFromCache( originalMaterial );

			originalMaterials[ outlineMaterial.uuid ] = originalMaterial;

			updateOutlineMaterial( outlineMaterial, originalMaterial );

			return outlineMaterial;

		}

		function isCompatible( object ) {

			const geometry = object.geometry;
			const hasNormals = ( geometry !== undefined ) && ( geometry.attributes.normal !== undefined );

			return ( object.isMesh === true && object.material !== undefined && hasNormals === true );

		}

		function setOutlineMaterial( object ) {

			if ( isCompatible( object ) === false ) return;

			if ( Array.isArray( object.material ) ) {

				for ( let i = 0, il = object.material.length; i < il; i ++ ) {

					object.material[ i ] = getOutlineMaterial( object.material[ i ] );

				}

			} else {

				object.material = getOutlineMaterial( object.material );

			}

			originalOnBeforeRenders[ object.uuid ] = object.onBeforeRender;
			object.onBeforeRender = onBeforeRender;

		}

		function restoreOriginalMaterial( object ) {

			if ( isCompatible( object ) === false ) return;

			if ( Array.isArray( object.material ) ) {

				for ( let i = 0, il = object.material.length; i < il; i ++ ) {

					object.material[ i ] = originalMaterials[ object.material[ i ].uuid ];

				}

			} else {

				object.material = originalMaterials[ object.material.uuid ];

			}

			object.onBeforeRender = originalOnBeforeRenders[ object.uuid ];

		}

		function onBeforeRender( renderer, scene, camera, geometry, material ) {

			const originalMaterial = originalMaterials[ material.uuid ];

			// just in case
			if ( originalMaterial === undefined ) return;

			updateUniforms( material, originalMaterial );

		}

		function updateUniforms( material, originalMaterial ) {

			const outlineParameters = originalMaterial.userData.outlineParameters;

			material.uniforms.outlineViewport.value.set( viewportWidth, viewportHeight );
			material.uniforms.outlineAlpha.value = originalMaterial.opacity;

			if ( outlineParameters !== undefined ) {

				if ( outlineParameters.thickness !== undefined ) material.uniforms.outlineThickness.value = outlineParameters.thickness;
				if ( outlineParameters.color !== undefined ) material.uniforms.outlineColor.value.fromArray( outlineParameters.color );
				if ( outlineParameters.alpha !== undefined ) material.uniforms.outlineAlpha.value = outlineParameters.alpha;

			}

			if ( originalMaterial.displacementMap ) {

				material.uniforms.displacementMap.value = originalMaterial.displacementMap;
				material.uniforms.displacementScale.value = originalMaterial.displacementScale;
				material.uniforms.displacementBias.value = originalMaterial.displacementBias;

			}

		}

		function updateOutlineMaterial( material, originalMaterial ) {

			if ( material.name === 'invisible' ) return;

			const outlineParameters = originalMaterial.userData.outlineParameters;

			material.fog = originalMaterial.fog;
			material.toneMapped = originalMaterial.toneMapped;
			material.premultipliedAlpha = originalMaterial.premultipliedAlpha;
			material.displacementMap = originalMaterial.displacementMap;

			if ( outlineParameters !== undefined ) {

				if ( originalMaterial.visible === false ) {

					material.visible = false;

				} else {

					material.visible = ( outlineParameters.visible !== undefined ) ? outlineParameters.visible : true;

				}

				material.transparent = ( outlineParameters.alpha !== undefined && outlineParameters.alpha < 1.0 ) ? true : originalMaterial.transparent;

				if ( outlineParameters.keepAlive !== undefined ) cache[ originalMaterial.uuid ].keepAlive = outlineParameters.keepAlive;

			} else {

				material.transparent = originalMaterial.transparent;
				material.visible = originalMaterial.visible;

			}

			if ( originalMaterial.wireframe === true || originalMaterial.depthTest === false ) material.visible = false;

			if ( originalMaterial.clippingPlanes ) {

				material.clipping = true;

				material.clippingPlanes = originalMaterial.clippingPlanes;
				material.clipIntersection = originalMaterial.clipIntersection;
				material.clipShadows = originalMaterial.clipShadows;

			}

			material.version = originalMaterial.version; // update outline material if necessary

		}

		function cleanupCache() {

			let keys;

			// clear originialMaterials
			keys = Object.keys( originalMaterials );

			for ( let i = 0, il = keys.length; i < il; i ++ ) {

				originalMaterials[ keys[ i ] ] = undefined;

			}

			// clear originalOnBeforeRenders
			keys = Object.keys( originalOnBeforeRenders );

			for ( let i = 0, il = keys.length; i < il; i ++ ) {

				originalOnBeforeRenders[ keys[ i ] ] = undefined;

			}

			// remove unused outlineMaterial from cache
			keys = Object.keys( cache );

			for ( let i = 0, il = keys.length; i < il; i ++ ) {

				const key = keys[ i ];

				if ( cache[ key ].used === false ) {

					cache[ key ].count ++;

					if ( cache[ key ].keepAlive === false && cache[ key ].count > removeThresholdCount ) {

						delete cache[ key ];

					}

				} else {

					cache[ key ].used = false;
					cache[ key ].count = 0;

				}

			}

		}

		this.render = function ( scene, camera ) {

			if ( this.enabled === false ) {

				renderer.render( scene, camera );
				return;

			}

			const currentAutoClear = renderer.autoClear;
			renderer.autoClear = this.autoClear;

			renderer.render( scene, camera );

			renderer.autoClear = currentAutoClear;

			this.renderOutline( scene, camera );

		};

		this.renderOutline = function ( scene, camera ) {

			const currentAutoClear = renderer.autoClear;
			const currentSceneAutoUpdate = scene.matrixWorldAutoUpdate;
			const currentSceneBackground = scene.background;
			const currentShadowMapEnabled = renderer.shadowMap.enabled;

			scene.matrixWorldAutoUpdate = false;
			scene.background = null;
			renderer.autoClear = false;
			renderer.shadowMap.enabled = false;

			scene.traverse( setOutlineMaterial );

			renderer.render( scene, camera );

			scene.traverse( restoreOriginalMaterial );

			cleanupCache();

			scene.matrixWorldAutoUpdate = currentSceneAutoUpdate;
			scene.background = currentSceneBackground;
			renderer.autoClear = currentAutoClear;
			renderer.shadowMap.enabled = currentShadowMapEnabled;

		};

		/*
		 * See #9918
		 *
		 * The following property copies and wrapper methods enable
		 * OutlineEffect to be called from other *Effect, like
		 *
		 * effect = new StereoEffect( new OutlineEffect( renderer ) );
		 *
		 * function render () {
		 *
	 	 * 	effect.render( scene, camera );
		 *
		 * }
		 */
		this.autoClear = renderer.autoClear;
		this.domElement = renderer.domElement;
		this.shadowMap = renderer.shadowMap;

		this.clear = function ( color, depth, stencil ) {

			renderer.clear( color, depth, stencil );

		};

		this.getPixelRatio = function () {

			return renderer.getPixelRatio();

		};

		this.setPixelRatio = function ( value ) {

			renderer.setPixelRatio( value );

		};

		this.getSize = function ( target ) {

			return renderer.getSize( target );

		};

		this.setSize = function ( width, height, updateStyle ) {

			renderer.setSize( width, height, updateStyle );

		};

		/**
		 * 只记录屏幕空间描边用的视口尺寸（CSS 像素），不触碰 renderer。
		 * `PetScene.setViewport()` 已负责唯一的 `renderer.setSize`（FF12 双 setSize 回归），
		 * 这里仅同步既有缓存材质的 `outlineViewport` uniform。
		 */
		this.setViewportSize = function ( width, height ) {

			const safeWidth = Number.isFinite( width ) && width > 0 ? width : 1;
			const safeHeight = Number.isFinite( height ) && height > 0 ? height : 1;

			viewportWidth = safeWidth;
			viewportHeight = safeHeight;

			for ( const key in cache ) {

				cache[ key ].material.uniforms.outlineViewport.value.set( safeWidth, safeHeight );

			}

		};

		this.setViewport = function ( x, y, width, height ) {

			renderer.setViewport( x, y, width, height );

		};

		this.setScissor = function ( x, y, width, height ) {

			renderer.setScissor( x, y, width, height );

		};

		this.setScissorTest = function ( boolean ) {

			renderer.setScissorTest( boolean );

		};

		this.setRenderTarget = function ( renderTarget ) {

			renderer.setRenderTarget( renderTarget );

		};

	}

}

export { OutlineEffect };
