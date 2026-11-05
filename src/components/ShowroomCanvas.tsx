"use client";

import { ContactShadows, Environment, MeshReflectorMaterial, useGLTF } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Box3, Mesh, Vector3, type Group, type Material } from "three";
import type { Mode } from "@/domain/types";
import { showroomMotion } from "./showroom-motion";

gsap.registerPlugin(ScrollTrigger);

const MODEL = "/models/showroom-suv.glb";

function gloss(material: Material) {
  const mat = material as Material & { envMapIntensity?: number; roughness?: number; metalness?: number };
  const tinted = mat as Material & { color?: { set: (hex: string) => void } };
  if (tinted.color) tinted.color.set("#d5dbe3");
  if (typeof mat.envMapIntensity === "number") mat.envMapIntensity = 1.8;
  if (typeof mat.roughness === "number") mat.roughness = 0.32;
  if (typeof mat.metalness === "number") mat.metalness = 0.55;
}

function Car() {
  const gltf = useGLTF(MODEL);
  const spin = useRef<Group>(null);

  useLayoutEffect(() => {
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    gltf.scene.position.set(-center.x, -box.min.y, -center.z);
    const span = Math.max(size.x, size.z, 0.001);
    const scale = 3.1 / span;
    gltf.scene.scale.setScalar(scale);
    gltf.scene.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach(gloss);
    });
  }, [gltf]);

  useFrame(() => {
    const group = spin.current;
    if (!group) return;
    const yaw = 0.55 + showroomMotion.progress * Math.PI * 0.85;
    group.rotation.y += (yaw - group.rotation.y) * 0.08;
  });

    return (
    <group ref={spin} position={[1.15, 0, 0]}>
      <primitive object={gltf.scene} />
    </group>
  );
}

function Rig() {
  useFrame((state) => {
    const p = showroomMotion.progress;
    const x = 2.4 + Math.sin(p * Math.PI) * 0.35 + showroomMotion.modeX;
    const y = 1.45 - p * 0.15;
    const z = 6.4 - p * 0.35;
    const cam = state.camera;
    cam.position.x += (x - cam.position.x) * 0.08;
    cam.position.y += (y - cam.position.y) * 0.08;
    cam.position.z += (z - cam.position.z) * 0.08;
    cam.lookAt(1.15, 0.62, 0);
  });
  return null;
}

export default function ShowroomCanvas({ mode, onReady }: { mode: Mode; onReady: () => void }) {
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: ".home-story",
        start: "top top",
        end: "bottom bottom",
        scrub: 0.7,
        onUpdate: (self) => {
          showroomMotion.progress = self.progress;
        },
      });
    });
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    gsap.to(showroomMotion, {
      modeX: mode === "flip" ? 1.15 : -0.55,
      duration: 0.9,
      ease: "power2.out",
      overwrite: "auto",
    });
  }, [mode]);

  return (
    <Canvas
      camera={{ position: [2.4, 1.45, 6.4], fov: 28 }}
      dpr={[1, 1.6]}
      shadows
      gl={{ antialias: true, alpha: false }}
      style={{ width: "100vw", height: "100vh" }}
      onCreated={() => ready.current()}
    >
      <color attach="background" args={["#050505"]} />
      <ambientLight intensity={0.18} />
      <spotLight position={[5, 7, 3]} intensity={50} angle={0.38} penumbra={0.85} castShadow color="#fff4ea" />
      <spotLight position={[-6, 3, -2]} intensity={22} angle={0.55} penumbra={1} color="#ff2a2a" />
      <spotLight position={[0, 4, -6]} intensity={12} angle={0.6} penumbra={1} color="#9ecbff" />
      <Car />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[1.15, -0.01, 0]}>
        <circleGeometry args={[3.4, 64]} />
        <MeshReflectorMaterial
          blur={[280, 80]}
          resolution={768}
          mixBlur={1}
          mixStrength={1.1}
          roughness={0.8}
          mirror={0.35}
          color="#080808"
          metalness={0.55}
        />
      </mesh>
      <ContactShadows position={[0, 0.01, 0]} opacity={0.45} scale={10} blur={2.4} far={4} />
      <Environment files="/hdri/studio.hdr" environmentIntensity={0.85} />
      <Rig />
    </Canvas>
  );
}
